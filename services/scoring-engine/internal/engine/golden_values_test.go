package engine

// The published results of arcana-score-formula/v1 on inputsFixture. See
// TestFormulaIsTheOnePublished for what to do when these stop matching.
//
// agent-service src/reputation/score-formula.ts publishes the same constants,
// and score-proof-verify holds the two to each other and to every manifest.
const goldenConstantsSHA = "64bffebf0471720ec601bcf04880cbd34a981c151fd27de64bd068f94805d7cd"

const goldenOutputs = `{"performance":59,"risk":80.4,"strategy":100,"regime":50,"consistency":58.42370311101605,"creator":54.69500000000001,"longevity":35,"strategy_multiplier":1,"ranked":true,"arcana":60.7}`
