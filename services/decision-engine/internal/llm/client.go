// Package llm is a provider-agnostic client for chat-completion APIs.
//
// It speaks the OpenAI chat-completions shape, which DeepSeek, Together,
// Groq, Mistral, OpenRouter and most hosted models accept. A provider is
// therefore three values — base URL, model id, API key — and changing provider
// is configuration, not surgery.
//
// THAT IS THE POINT, and it is not theoretical. `deepseek-chat` was named in
// the plan for this work and had already been retired on 2026-07-24 while the
// plan was being written. A decision engine wired directly to one vendor's SDK
// would have needed opening up to learn that; this one needs an env var.
//
// Nothing in this package knows what a trade is. It sends messages and returns
// text, plus the metadata a decision has to record about how that text was
// produced. Keeping it ignorant is what stops provider details leaking into
// the engine.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Config is everything that identifies a provider.
type Config struct {
	// Name is recorded on every decision, so a year from now the record says
	// which service answered rather than which one is configured today.
	Name    string
	BaseURL string // e.g. https://api.deepseek.com
	APIKey  string
	Model   string

	Temperature float64
	TopP        float64
	MaxTokens   int
	// Seed is sent when non-zero. Providers do not guarantee determinism even
	// with it, which is why the evidence model is "attested" rather than
	// "reproducible" — but recording what was asked for still matters.
	Seed int

	Timeout time.Duration
	// JSONMode asks the provider to constrain output to valid JSON. Supported
	// by DeepSeek and OpenAI-compatible providers; harmless where ignored,
	// because the response is validated against a schema regardless.
	JSONMode bool

	// ExtraBody is merged into the request body verbatim, and exists because
	// "a provider is three values" stopped being true the moment one of them
	// was a reasoning model.
	//
	// mimo-v2.5 thinks before it answers, and the thinking is billed and
	// capped as completion tokens. With MaxTokens at 700 the thinking used
	// 699 of them and the answer was cut off at zero characters — measured,
	// three runs out of three — so every LLM decision this engine recorded
	// was a forced hold on a truncated response. The switch that turns it off
	// is `chat_template_kwargs.enable_thinking`, which no struct field here
	// should be named after: the next provider will spell it differently, and
	// a typed field per vendor quirk is how this package stops being
	// provider-agnostic.
	//
	// NOTE FOR WHOEVER SETS THIS: the obvious top-level `enable_thinking`
	// is accepted and SILENTLY IGNORED by this provider — 200 OK, still 699
	// reasoning tokens. It has to go inside `chat_template_kwargs`. A setting
	// that looks applied and is not is worse than one that errors.
	ExtraBody map[string]any
}

// Client talks to one provider.
type Client struct {
	cfg  Config
	http *http.Client
}

func New(cfg Config) *Client {
	if cfg.Timeout == 0 {
		cfg.Timeout = 30 * time.Second
	}
	return &Client{cfg: cfg, http: &http.Client{Timeout: cfg.Timeout}}
}

// Configured reports whether this client can be used at all.
//
// A client without a key is not an error at construction time — the service
// still boots and serves /healthz — but it must never silently do something
// else instead. See engine.Decider selection.
func (c *Client) Configured() bool {
	return c.cfg.APIKey != "" && c.cfg.BaseURL != "" && c.cfg.Model != ""
}

func (c *Client) Provider() string { return c.cfg.Name }
func (c *Client) Model() string    { return c.cfg.Model }

// Params returns the settings that shaped a response, for the decision record.
func (c *Client) Params() map[string]any {
	p := map[string]any{
		"temperature": c.cfg.Temperature,
		"top_p":       c.cfg.TopP,
		"max_tokens":  c.cfg.MaxTokens,
		"json_mode":   c.cfg.JSONMode,
		"timeout_ms":  c.cfg.Timeout.Milliseconds(),
	}
	if c.cfg.Seed != 0 {
		p["seed"] = c.cfg.Seed
	}
	// Recorded like every other setting that shaped the answer. Whether the
	// model was allowed to think is not a footnote about plumbing — it is the
	// difference between two different models answering, and a decision record
	// that omits it cannot explain why the same prompt reasoned one week and
	// did not the next.
	for k, v := range c.cfg.ExtraBody {
		p[k] = v
	}
	return p
}

// Message is one turn of the conversation.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Completion is what came back, plus what it cost.
type Completion struct {
	// Raw is the entire response body, before any parsing. Stored as evidence:
	// a malformed answer is still a fact about what the model did, and a record
	// that only keeps successfully parsed answers quietly hides the failures.
	Raw string
	// Text is the assistant message content.
	Text string
	// ModelVersion is what the provider says it actually served, which can
	// differ from what was requested — `deepseek-v4-pro` is routed to V4.1
	// Flash, for one.
	ModelVersion     string
	PromptTokens     int
	CompletionTokens int
	CachedTokens     int
	LatencyMS        int64
}

// ErrUnavailable means the provider could not be reached or refused to answer.
// The caller turns this into a recorded hold, never into a dropped tick.
var ErrUnavailable = errors.New("llm provider unavailable")

// ErrTruncated means the provider stopped because it hit the token cap, not
// because it had finished.
//
// SEPARATE FROM A PARSE FAILURE ON PURPOSE. Both end the tick in a hold, but
// they are different faults with different fixes and they were indistinguishable
// for as long as the only record said "output rejected": a cut-off answer is not
// a model that answered badly, it is an answer this engine never let it finish,
// and the person reading the log needs to know the cap is theirs to raise.
var ErrTruncated = errors.New("llm response truncated at the token cap")

type chatRequest struct {
	Model          string          `json:"model"`
	Messages       []Message       `json:"messages"`
	Temperature    float64         `json:"temperature"`
	TopP           float64         `json:"top_p,omitempty"`
	MaxTokens      int             `json:"max_tokens,omitempty"`
	Seed           int             `json:"seed,omitempty"`
	ResponseFormat *responseFormat `json:"response_format,omitempty"`
}

type responseFormat struct {
	Type string `json:"type"`
}

type chatResponse struct {
	Model   string `json:"model"`
	Choices []struct {
		Message      Message `json:"message"`
		FinishReason string  `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens         int `json:"prompt_tokens"`
		CompletionTokens     int `json:"completion_tokens"`
		PromptCacheHitTokens int `json:"prompt_cache_hit_tokens"`
		// Thinking, counted inside CompletionTokens rather than beside them.
		// Read so that a truncation can say what consumed the budget instead
		// of leaving the reader to guess that a 700-token cap was spent on
		// reasoning nobody ever sees.
		CompletionTokensDetails *struct {
			ReasoningTokens int `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

// Complete sends one request and returns what came back.
//
// Every failure path returns ErrUnavailable wrapped with a cause. The caller
// must not need to distinguish "connection refused" from "HTTP 500" to know
// what to do: in both cases the agent did not get an answer and must not trade.
func (c *Client) Complete(ctx context.Context, msgs []Message) (*Completion, error) {
	if !c.Configured() {
		return nil, fmt.Errorf("%w: provider %q is not configured", ErrUnavailable, c.cfg.Name)
	}

	body := chatRequest{
		Model:       c.cfg.Model,
		Messages:    msgs,
		Temperature: c.cfg.Temperature,
		TopP:        c.cfg.TopP,
		MaxTokens:   c.cfg.MaxTokens,
		Seed:        c.cfg.Seed,
	}
	if c.cfg.JSONMode {
		body.ResponseFormat = &responseFormat{Type: "json_object"}
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("%w: encode request: %v", ErrUnavailable, err)
	}
	// Merge the provider-specific fields over the encoded struct. Done here
	// rather than by building the whole body as a map so the typed request
	// stays the description of what every provider gets, and ExtraBody stays
	// visibly the exception.
	if len(c.cfg.ExtraBody) > 0 {
		var merged map[string]json.RawMessage
		if err := json.Unmarshal(buf, &merged); err != nil {
			return nil, fmt.Errorf("%w: merge extra body: %v", ErrUnavailable, err)
		}
		for k, v := range c.cfg.ExtraBody {
			enc, err := json.Marshal(v)
			if err != nil {
				return nil, fmt.Errorf("%w: encode extra body field %q: %v", ErrUnavailable, k, err)
			}
			merged[k] = enc
		}
		if buf, err = json.Marshal(merged); err != nil {
			return nil, fmt.Errorf("%w: encode merged request: %v", ErrUnavailable, err)
		}
	}

	url := strings.TrimRight(c.cfg.BaseURL, "/") + "/v1/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return nil, fmt.Errorf("%w: build request: %v", ErrUnavailable, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)

	start := time.Now()
	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer res.Body.Close()

	// Read the body before judging the status: an error body usually says why,
	// and "HTTP 400" alone sends whoever reads the journal to the wrong place.
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("%w: read response: %v", ErrUnavailable, err)
	}
	latency := time.Since(start).Milliseconds()

	if res.StatusCode >= 400 {
		return nil, fmt.Errorf("%w: HTTP %d: %s", ErrUnavailable, res.StatusCode, truncate(string(raw), 400))
	}

	var parsed chatResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("%w: response was not JSON: %s", ErrUnavailable, truncate(string(raw), 400))
	}
	if parsed.Error != nil {
		return nil, fmt.Errorf("%w: provider error: %s", ErrUnavailable, parsed.Error.Message)
	}
	if len(parsed.Choices) == 0 {
		return nil, fmt.Errorf("%w: provider returned no choices", ErrUnavailable)
	}

	// THE CAP, BEFORE THE SCHEMA. A response stopped at `length` is judged here
	// and not left to the parser downstream, because the parser can only report
	// that the JSON was bad — which sends the reader to the prompt and the
	// schema, neither of which is at fault.
	if parsed.Choices[0].FinishReason == "length" {
		reasoning := 0
		if d := parsed.Usage.CompletionTokensDetails; d != nil {
			reasoning = d.ReasoningTokens
		}
		return nil, fmt.Errorf(
			"%w: stopped at max_tokens=%d after %d completion tokens (%d of them reasoning, "+
				"leaving %d for the answer)",
			ErrTruncated, c.cfg.MaxTokens, parsed.Usage.CompletionTokens, reasoning,
			parsed.Usage.CompletionTokens-reasoning)
	}

	return &Completion{
		Raw:              string(raw),
		Text:             parsed.Choices[0].Message.Content,
		ModelVersion:     parsed.Model,
		PromptTokens:     parsed.Usage.PromptTokens,
		CompletionTokens: parsed.Usage.CompletionTokens,
		CachedTokens:     parsed.Usage.PromptCacheHitTokens,
		LatencyMS:        latency,
	}, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
