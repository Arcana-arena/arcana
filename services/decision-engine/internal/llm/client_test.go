package llm

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The two behaviours here are the ones that failed in production without
// leaving a mark: a body field that was never sent, and a response that was cut
// off mid-sentence and reported as a bad answer. Both were invisible because
// the only evidence either produced was a number in a database column.

func newTestClient(t *testing.T, handler http.HandlerFunc, cfg Config) (*Client, func()) {
	t.Helper()
	srv := httptest.NewServer(handler)
	cfg.Name = "test"
	cfg.BaseURL = srv.URL
	cfg.APIKey = "k"
	if cfg.Model == "" {
		cfg.Model = "m"
	}
	return New(cfg), srv.Close
}

// A completion stopped by the token cap is ErrTruncated, not a parse problem
// handed to the caller as if the model had answered.
func TestCompleteTruncatedIsItsOwnError(t *testing.T) {
	body := `{"model":"m","choices":[{"message":{"role":"assistant","content":""},
	          "finish_reason":"length"}],
	          "usage":{"prompt_tokens":4721,"completion_tokens":700,
	                   "completion_tokens_details":{"reasoning_tokens":699}}}`
	c, done := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, body)
	}, Config{MaxTokens: 700})
	defer done()

	_, err := c.Complete(context.Background(), []Message{{Role: "user", Content: "hi"}})
	if !errors.Is(err, ErrTruncated) {
		t.Fatalf("want ErrTruncated, got %v", err)
	}
	if errors.Is(err, ErrUnavailable) {
		t.Fatal("a truncated answer is not an unavailable provider: the caller " +
			"records a different reason code for each")
	}
	// The numbers are the whole point of the message — without them the reader
	// cannot tell a long answer from thinking that ate the budget.
	for _, want := range []string{"max_tokens=700", "699 of them reasoning", "leaving 1 for the answer"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should say %q; got %q", want, err.Error())
		}
	}
}

// ExtraBody reaches the wire, and does not displace the typed fields.
func TestCompleteMergesExtraBody(t *testing.T) {
	var got map[string]any
	c, done := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &got)
		io.WriteString(w, `{"model":"m","choices":[{"message":{"content":"{}"},
		                    "finish_reason":"stop"}],"usage":{}}`)
	}, Config{
		MaxTokens:   700,
		Temperature: 0.2,
		ExtraBody: map[string]any{
			"chat_template_kwargs": map[string]any{"enable_thinking": false},
		},
	})
	defer done()

	if _, err := c.Complete(context.Background(), []Message{{Role: "user", Content: "hi"}}); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	kw, ok := got["chat_template_kwargs"].(map[string]any)
	if !ok {
		t.Fatalf("chat_template_kwargs missing from request body: %v", got)
	}
	if kw["enable_thinking"] != false {
		t.Errorf("enable_thinking = %v, want false", kw["enable_thinking"])
	}
	if got["model"] != "m" || got["max_tokens"] != float64(700) {
		t.Errorf("merging extras dropped typed fields: model=%v max_tokens=%v",
			got["model"], got["max_tokens"])
	}
	if _, sent := got["messages"]; !sent {
		t.Error("messages missing from request body")
	}
}

// Params carries the extras, because a decision record that omits whether the
// model was allowed to think cannot explain its own latency a year from now.
func TestParamsIncludesExtraBody(t *testing.T) {
	c := New(Config{
		Name: "test", BaseURL: "http://x", APIKey: "k", Model: "m", MaxTokens: 700,
		ExtraBody: map[string]any{"chat_template_kwargs": map[string]any{"enable_thinking": false}},
	})
	if _, ok := c.Params()["chat_template_kwargs"]; !ok {
		t.Errorf("Params() should record the provider extras; got %v", c.Params())
	}
}
