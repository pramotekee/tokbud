/* ============================================================================
   TOKBUD — My Type Narrative Engine  (mytype-narrative.txt)
   ----------------------------------------------------------------------------
   Loaded via <script src="mytype-narrative.txt"></script> AFTER mytype.txt.
   Deliberately self-contained: does not read MYTYPE_QUESTIONS or any other
   global from mytype.txt. Only needs the raw `answers` object that
   actionGetMyType() already returns ({ q01: 73, q02: 40, ... }).

   Why separate from mytype.txt (locked decision, see handoff):
   page 1 (existing, ships to everyone) and page 2 (this file) are meant to
   stay independently editable/removable — e.g. a future paywall can gate
   page 2 without touching page 1's code at all.

   Public entry point other files should call:
     buildMyTypeNarrativePage(displayName, answers) -> HTML string for page 2

   Guardrails carried over from the original design (WEZIDE project):
   - mapping + narrative content live in data objects below, not if/else chains
   - raw input validated to 0..100 (see mteCalculateDimension)
   - a dimension with too few / no answered contributing questions degrades
     gracefully (confidence:'low' or null) instead of crashing or headlining
   - q50 was originally marked "duplicate of q11, exclude" in an earlier
     internal numbering — but real q50 in production ("Touchy-Feely <-> Give Me
     Space") is a genuine, different question, confirmed by Pop to be scored
     (not excluded), mapped into relationship_orientation. See note on q50 below.
   - never phrase output as hiring/performance/mental-health conclusions
   ============================================================================ */

/* ----------------------------------------------------------------------------
   1. Question -> dimension mapping (all 50 real MYTYPE_QUESTIONS keys)
   ----------------------------------------------------------------------------
   IMPORTANT: an earlier internal numbering had numbered its own q01..q50 in
   a DIFFERENT order than the deployed
   MYTYPE_QUESTIONS array in mytype.txt. Every row below was re-matched by
   comparing actual question text (a/b pair), not by q-number, so these keys
   are safe to use directly against the real `answers` object. `pref:true`
   entries are display-only chips (per spec: never used as scoring evidence).
   ---------------------------------------------------------------------------- */
const MYTYPE_NARRATIVE_MAP = {
  q01: { pref: true },                                                                    // Sunrise / Nightlife
  q02: { maps: [ { dimension: 'social_collaboration', polarity: 1, weight: 1.0 } ] },      // Introvert / Extrovert
  q03: { pref: true },                                                                    // Home Addict / Traveller
  q04: { pref: true },                                                                    // Coffee / Tea
  q05: { pref: true },                                                                    // Save Money / Spend on Experience (values-only, not scored)
  q06: { maps: [ { dimension: 'structure_autonomy', polarity: 1, weight: 0.5 } ] },        // Minimalist / Maximizer
  q07: { pref: true },                                                                    // Walk Everywhere / Drive Everywhere
  q08: { pref: true },                                                                    // Park Person / Mall Person
  q09: { pref: true },                                                                    // Work From Cafe / Office Person
  q10: { pref: true },                                                                    // Beach Escape / Mountain Escape
  q11: { pref: true },                                                                    // Desk Person / Field Person
  q12: { pref: true },                                                                    // Take Photos / Live the Moment
  q13: { maps: [
    { dimension: 'social_collaboration', polarity: 1, weight: 1.0 },
    { dimension: 'relationship_orientation', polarity: 1, weight: 0.5 }
  ] },                                                                                     // Small Talk / Deep Talk
  q14: { maps: [
    { dimension: 'structure_autonomy', polarity: -1, weight: 1.0 },
    { dimension: 'growth_adaptability', polarity: 1, weight: 0.5 }
  ] },                                                                                     // Plan Everything / Go With the Flow
  q15: { pref: true },                                                                    // Take Selfie / Take Scenery
  q16: { pref: true },                                                                    // Love Rain / Love Sunshine
  q17: { maps: [ { dimension: 'thinking_decision', polarity: -1, weight: 1.0 } ] },        // Logic / Emotion
  q18: { maps: [ { dimension: 'structure_autonomy', polarity: -1, weight: 0.5 } ] },       // Clean Desk / Creative Mess
  q19: { maps: [ { dimension: 'social_collaboration', polarity: 1, weight: 1.0 } ] },      // Do It Alone / Do It Together
  q20: { maps: [
    { dimension: 'achievement_drive', polarity: -1, weight: 1.0 },
    { dimension: 'social_collaboration', polarity: 1, weight: 1.0 }
  ] },                                                                                     // Win First / Team First
  q21: { maps: [ { dimension: 'structure_autonomy', polarity: 1, weight: 1.0 } ] },        // Live for Today / Plan for Tomorrow
  q22: { maps: [ { dimension: 'growth_adaptability', polarity: -1, weight: 1.0 } ] },      // Embrace Uncertainty / Choose Stability
  q23: { maps: [ { dimension: 'social_collaboration', polarity: -1, weight: 1.0 } ] },     // Stand Out / Fit In
  q24: { maps: [ { dimension: 'achievement_drive', polarity: 1, weight: 1.0 } ] },         // Money First / Purpose First
  q25: { maps: [ { dimension: 'thinking_decision', polarity: 1, weight: 1.0 } ] },         // Specialist / Generalist
  q26: { pref: true },                                                                    // Corporate / Startup
  q27: { maps: [
    { dimension: 'structure_autonomy', polarity: 1, weight: 1.0 },
    { dimension: 'achievement_drive', polarity: -1, weight: 0.5 }
  ] },                                                                                     // Done is Better / Perfect is Great
  q28: { maps: [ { dimension: 'growth_adaptability', polarity: -1, weight: 1.0 } ] },      // Stay Curious / Stay Comfortable
  q29: { maps: [
    { dimension: 'growth_adaptability', polarity: -1, weight: 1.0 },
    { dimension: 'achievement_drive', polarity: -1, weight: 0.5 }
  ] },                                                                                     // Challenge Me / Keep It Easy
  q30: { maps: [ { dimension: 'thinking_decision', polarity: 1, weight: 1.0 } ] },         // Detail Obsessed / Big Picture
  q31: { maps: [
    { dimension: 'thinking_decision', polarity: 1, weight: 0.5 },
    { dimension: 'growth_adaptability', polarity: 1, weight: 0.5 }
  ] },                                                                                     // Doer / Dreamer
  q32: { maps: [
    { dimension: 'achievement_drive', polarity: -1, weight: 0.5 },
    { dimension: 'structure_autonomy', polarity: 1, weight: 0.5 }
  ] },                                                                                     // Move Fast / Slow But Sure
  q33: { maps: [ { dimension: 'achievement_drive', polarity: -1, weight: 1.0 } ] },        // Goal Driven / Journey Driven
  q34: { maps: [ { dimension: 'growth_adaptability', polarity: -1, weight: 1.0 } ] },      // Build From Zero / Improve From Existing
  q35: { maps: [
    { dimension: 'communication_style', polarity: 1, weight: 1.0 },
    { dimension: 'social_collaboration', polarity: -1, weight: 0.5 }
  ] },                                                                                     // Speak My Mind / Listen First
  q36: { maps: [
    { dimension: 'communication_style', polarity: 1, weight: 1.0 },
    { dimension: 'social_collaboration', polarity: 1, weight: 0.5 }
  ] },                                                                                     // Reach The Point / Read The Room
  q37: { maps: [
    { dimension: 'achievement_drive', polarity: -1, weight: 1.0 },
    { dimension: 'growth_adaptability', polarity: 1, weight: 0.5 }
  ] },                                                                                     // No Pain No Gain / No Stress Just Progress
  q38: { maps: [
    { dimension: 'structure_autonomy', polarity: -1, weight: 1.0 },
    { dimension: 'relationship_orientation', polarity: 1, weight: 0.5 }
  ] },                                                                                     // Commitment / Freedom
  q39: { maps: [ { dimension: 'relationship_orientation', polarity: -1, weight: 1.0 } ] }, // Serious Relationship / Keep It Casual
  q40: { maps: [
    { dimension: 'social_collaboration', polarity: -1, weight: 1.0 },
    { dimension: 'relationship_orientation', polarity: 1, weight: 0.5 }
  ] },                                                                                     // Work as a Team / Work as a Family
  q41: { maps: [ { dimension: 'social_collaboration', polarity: -1, weight: 1.0 } ] },     // Party Animal / Give Me A Zone
  q42: { maps: [
    { dimension: 'relationship_orientation', polarity: 1, weight: 0.5 },
    { dimension: 'growth_adaptability', polarity: 1, weight: 0.5 }
  ] },                                                                                     // Like Me / Surprise Me
  q43: { maps: [ { dimension: 'social_collaboration', polarity: -1, weight: 1.0 } ] },     // On Stage / Back Stage
  q44: { pref: true },                                                                    // Fine Dining / Street Food
  q45: { maps: [ { dimension: 'relationship_orientation', polarity: 1, weight: 1.0 } ] },  // Marriage Minded / Happy Being Single
  q46: { maps: [ { dimension: 'relationship_orientation', polarity: 1, weight: 1.0 } ] },  // Love at First Sight / Love Takes Time
  q47: { maps: [
    { dimension: 'communication_style', polarity: 1, weight: 1.0 },
    { dimension: 'relationship_orientation', polarity: -1, weight: 0.5 }
  ] },                                                                                     // Say It With Words / Show It With Actions
  q48: { maps: [
    { dimension: 'communication_style', polarity: -1, weight: 1.0 },
    { dimension: 'social_collaboration', polarity: -1, weight: 0.5 }
  ] },                                                                                     // Say It Straight / Keep the Peace
  q49: { maps: [ { dimension: 'relationship_orientation', polarity: 1, weight: 1.0 } ] },  // Chemistry First / Compatibility First
  // q50: real production question ("Touchy-Feely <-> Give Me Space") is NOT the
  // spec's placeholder duplicate -- confirmed by Pop to be scored, not excluded.
  // raw 0 (Touchy-Feely) leans toward depth/closeness -> dimension HIGH, so it
  // needs the reversed polarity (-1) to normalize correctly. weight 1.0 = direct
  // signal, same tier as q45/q49.
  q50: { maps: [ { dimension: 'relationship_orientation', polarity: -1, weight: 1.0 } ] }  // Touchy-Feely / Give Me Space
};

/* ----------------------------------------------------------------------------
   2. Dimensions + human-readable label pairs (for "What Stands Out" badges)
   ---------------------------------------------------------------------------- */
const MYTYPE_DIMENSIONS = [
  'achievement_drive', 'growth_adaptability', 'structure_autonomy',
  'thinking_decision', 'social_collaboration', 'communication_style',
  'relationship_orientation'
];

// high = the trait shown when score is HIGH (raw normalized toward 100);
// low = the trait shown when score is LOW (toward 0). 'balanced' band never
// gets a label here -- it is intentionally not shown as a headline (see
// mteDominantSignals / mteChooseSectionDimensions).
const MYTYPE_DIMENSION_LABELS = {
  achievement_drive:        { high: 'Goal-Driven',                  low: 'Progress-Driven' },
  growth_adaptability:      { high: 'Exploratory Seeker',           low: 'Stability Seeker' },
  structure_autonomy:       { high: 'Structure Keeper',             low: 'Flexible Navigator' },
  thinking_decision:        { high: 'Big-Picture Thinker',          low: 'Detail-Focused Thinker' },
  social_collaboration:     { high: 'Socially Energized',           low: 'Independently Energized' },
  communication_style:      { high: 'Context-First Communicator',   low: 'Direct Communicator' },
  relationship_orientation: { high: 'Deep & Committed',             low: 'Open & Easygoing' }
};

/* ----------------------------------------------------------------------------
   3. Core narrative block library (spec §7, verbatim) + combination rules
      (spec §8, reworded to match each target section's person-voice --
      spec's own JSON examples mixed 1st/2nd person inconsistently; see the
      chat note that ships alongside this file for the full list of section
      assignments I inferred, since only 2 of the 10 rules had an explicit
      section in the spec).
   ---------------------------------------------------------------------------- */
const MYTYPE_NARRATIVE_BLOCKS = {
  achievement_drive: {
    high:     { personal: 'You are energized by progress, meaningful goals, and seeing effort move something forward, more than by staying comfortable.',
                work: 'Clear goals, visible progress, and ownership help you do your best work, since a project with no clear finish line can feel harder to stay motivated on.',
                notice: 'I may look for the next challenge and become restless when progress feels too slow, even if the current one is not finished yet.',
                working: 'Give me a clear goal and room to move it forward. Regular markers of progress help more than a single deadline far in the future.' },
    balanced: { personal: 'You can balance pursuing results with appreciating the journey, shifting between the two as needed.',
                work: 'A clear outcome with a sustainable pace tends to work well for you, without needing constant urgency to stay engaged.',
                notice: 'I can shift between pushing ahead and slowing down when the situation needs it, rather than defaulting to one speed.',
                working: 'Align on the goal and the pace with me, and I can adapt to either a sprint or a marathon.' },
    low:      { personal: 'You may value sustainable progress, experience, and balance over constant achievement, rather than chasing every milestone.',
                work: 'A thoughtful pace and work that feels worthwhile can bring out your best, more than pressure to hit an aggressive number.',
                notice: 'I may protect quality of experience rather than chase every next milestone, even if that means moving a little slower.',
                working: 'Avoid creating urgency for its own sake. Explain what truly matters and why, and I will meet you there.' }
  },
  growth_adaptability: {
    high:     { personal: 'You are drawn to learning, experimentation, and new possibilities, more than repeating what already works.',
                work: 'Room to explore, improve, and adapt works better than a rigid script, since a fixed process can start to feel limiting fairly quickly.',
                notice: 'I may ask "what if?" and question established ways of doing things, even ones that already work reasonably well.',
                working: 'Give me direction and space to experiment. I tend to find a better way when I am allowed to test a few first.' },
    balanced: { personal: 'You can appreciate both exploration and stability, depending on the situation, without needing to pick one.',
                work: 'A balance of proven methods and room for improvement suits you better than either extreme on its own.',
                notice: 'I can try a new route when it clearly helps, while still respecting what already works well enough.',
                working: 'Share the reason for a change along with the practical constraints, and I can work well within either direction.' },
    low:      { personal: 'You may prefer proven approaches and enough stability to build confidence before changing direction, rather than adapting for its own sake.',
                work: 'Clear expectations and a reliable process help you perform confidently, especially when the stakes of getting it wrong are high.',
                notice: 'I may test the practical case for a change before committing to it, rather than adopting something new right away.',
                working: 'Give context, time, and a clear plan when introducing change, and I am far more likely to get on board.' }
  },
  structure_autonomy: {
    high:     { personal: 'You tend to value planning, clarity, and knowing what needs to happen next, even under pressure.',
                work: 'Clear expectations, ownership, and a workable structure help you perform, while ambiguity about what is expected can slow you down.',
                notice: 'I may plan ahead and care about how work is organized, sometimes more than the people around me do.',
                working: 'Be clear about the destination and responsibilities from the start, and avoid unnecessary ambiguity about who owns what.' },
    balanced: { personal: 'You can move between structure and flexibility as the situation requires, without feeling locked into either.',
                work: 'A light framework with room to adjust tends to work well, giving you enough direction without boxing you in.',
                notice: 'I can plan when needed without needing every detail fixed in advance, and I am comfortable filling in the gaps.',
                working: 'Agree on the essentials together, then leave room for me to adapt the rest as things unfold.' },
    low:      { personal: 'You may prefer flexibility and room to adapt over a fixed process, which can feel limiting.',
                work: 'Freedom in how you approach work can bring out your best, more than a step-by-step process ever could.',
                notice: 'I may work things out as I go rather than over-plan the route, trusting that I can adjust along the way.',
                working: 'Define the outcome, not every step. Close oversight tends to slow me down rather than help.' }
  },
  thinking_decision: {
    high:     { personal: 'You tend to connect ideas, patterns, and the bigger picture before deciding what matters, stepping back before diving in.',
                work: 'Context and the "why" behind a problem help you contribute most, more than a list of tasks without the reasoning behind them.',
                notice: 'I may step back, question assumptions, and look for the underlying pattern before agreeing with the first answer given.',
                working: 'Share the problem and context, not only the task. I do better work once I understand what it is really for.' },
    balanced: { personal: 'You can move between practical details and broader possibilities, depending on what a moment calls for.',
                work: 'A clear goal plus enough context lets you choose the right level of detail without needing everything spelled out.',
                notice: 'I can zoom in on the details or step back to the bigger picture, depending on what the work needs.',
                working: 'Tell me what decision is needed and the level of detail that matters, and I will match my approach to it.' },
    low:      { personal: 'You tend to focus on what is practical, specific, and immediately actionable, over an open-ended idea.',
                work: 'Concrete details and clear next steps help you make decisions quickly, without needing to explore every possible angle first.',
                notice: 'I may bring discussions back to execution and what can be done now, rather than staying in the idea stage too long.',
                working: 'Be specific about the facts, constraints, and next actions. I move faster once I know exactly what is needed.' }
  },
  social_collaboration: {
    high:     { personal: 'You gain energy and perspective through interaction, shared ideas, and collective progress, often thinking out loud with others.',
                work: 'Purposeful collaboration and shared ownership can bring out your best work, more than tasks handled entirely on your own.',
                notice: 'I may involve others, talk ideas through out loud, and pay attention to how the group is responding as we go.',
                working: 'Include me in meaningful discussions and align us around a shared goal. I contribute more once I feel part of it.' },
    balanced: { personal: 'You can enjoy collaboration while still needing independent space, without one costing the other.',
                work: 'A mix of teamwork and focused individual time tends to suit you, depending on what the task in front of you needs.',
                notice: 'I can contribute in groups and work independently when needed, adjusting to whichever the moment calls for.',
                working: 'Be clear about when we should collaborate and when ownership is individual, and I will move naturally between the two.' },
    low:      { personal: 'You may prefer focused interaction and enough personal space to think and recharge, rather than constant back-and-forth.',
                work: 'Quiet focus and purposeful meetings work better than constant social demands, which can wear on your energy over time.',
                notice: 'I may listen more than I speak, and I would rather have one meaningful conversation than several short ones.',
                working: 'Do not mistake quietness for disengagement. Give me time to think it through, then invite my input directly.' }
  },
  communication_style: {
    high:     { personal: 'You tend to consider people, timing, and context before choosing how to communicate, reading the room first.',
                work: 'Thoughtful timing and tone make collaboration easier, and you tend to notice when a message needs softening before it is sent.',
                notice: 'I may listen first, read the room, and show care through practical follow-through rather than a lot of reassuring words.',
                working: 'Share context and be mindful of timing. I value a considerate approach, especially around anything sensitive.' },
    balanced: { personal: 'You can be clear while adapting your style to the people and situation, without losing the point.',
                work: 'Direct expectations with room for context tend to work well, letting you adjust tone without losing clarity.',
                notice: 'I can speak plainly when that is what is needed, or take a more thoughtful approach when the moment calls for it.',
                working: 'Be honest and clear with me, and I will adjust my own approach depending on the situation.' },
    low:      { personal: 'You tend to value clarity, honesty, and getting to the point, over softening a message.',
                work: 'Straightforward feedback and clear expectations help you move quickly, without needing to read between the lines.',
                notice: 'I may say what I think directly when clarity matters, even if a gentler phrasing would take longer to land.',
                working: 'Be clear with me. I prefer an honest, direct conversation to guessing at what is actually meant.' }
  },
  // Relationship Orientation: spec explicitly says "use sparingly in work
  // outputs; best suited to Personal Reflection and Working With Me" -- so it
  // only has personal/working text, and MYTYPE_SECTION_PRIORITY (below) never
  // routes it into how_i_work_best / what_you_may_notice.
  relationship_orientation: {
    high:     { personal: 'You tend to value depth, trust, consistency, and relationships that develop over time, rather than many surface-level ones.',
                working: 'Trust matters to me, and once it is established, I tend to invest more deeply and stay consistent over time.' },
    balanced: { personal: 'You can value both independence and connection, depending on the relationship and context, without needing to choose.',
                working: 'I value both personal space and genuine connection, and I do not need one to come at the cost of the other.' },
    low:      { personal: 'You may place greater value on freedom, flexibility, and maintaining your own space, even in close relationships.',
                working: 'Respect my independence and let connection develop naturally, rather than expecting it on a set timeline.' }
  }
};

const MYTYPE_COMBINATION_RULES = [
  { id: 'social_low_comm_low',        when: { social_collaboration: 'low', communication_style: 'low' },  section: 'what_you_may_notice',
    text: 'I may prefer fewer interactions, but when something matters, I tend to communicate clearly.' },
  { id: 'growth_high_structure_high', when: { growth_adaptability: 'high', structure_autonomy: 'high' },  section: 'how_i_work_best',
    text: 'You enjoy change, but not chaos. Experimentation works best when there is enough structure to keep it moving.' },
  { id: 'growth_high_achv_high',      when: { growth_adaptability: 'high', achievement_drive: 'high' },   section: 'how_i_work_best',
    text: 'You are likely to enjoy challenges that give you both progress and learning.' },
  { id: 'achv_high_social_high',      when: { achievement_drive: 'high', social_collaboration: 'high' },  section: 'how_i_work_best',
    text: 'You may be motivated by achieving something meaningful with others, not only by individual results.' },
  { id: 'achv_high_structure_low',    when: { achievement_drive: 'high', structure_autonomy: 'low' },     section: 'how_i_work_best',
    text: 'You care strongly about outcomes while preferring flexibility in how you get there.' },
  { id: 'social_high_structure_low',  when: { social_collaboration: 'high', structure_autonomy: 'low' },  section: 'how_i_work_best',
    text: 'You enjoy working with people without needing every step to be tightly prescribed.' },
  { id: 'structure_high_growth_low',  when: { structure_autonomy: 'high', growth_adaptability: 'low' },   section: 'what_you_may_notice',
    text: 'I may prefer improving a proven approach rather than constantly reinventing it.' },
  { id: 'structure_low_growth_high',  when: { structure_autonomy: 'low', growth_adaptability: 'high' },   section: 'what_you_may_notice',
    text: 'I may be comfortable navigating ambiguity and figuring things out as I go.' },
  { id: 'social_low_comm_high',       when: { social_collaboration: 'low', communication_style: 'high' }, section: 'what_you_may_notice',
    text: 'I may prefer a smaller number of meaningful interactions and take time to read the situation before responding.' },
  { id: 'relationship_high_structure_low', when: { relationship_orientation: 'high', structure_autonomy: 'low' }, section: 'what_you_may_notice',
    text: 'I can value deep connection without wanting to lose independence.' }
];

// Which dimensions each non-headline section draws from (spec §6 "Section
// signal priorities" table). Personal Reflection is not listed here -- it
// always draws from the top-3 dominant signals across all 7 dimensions
// (see mteDominantSignals), same pool used for the "What Stands Out" badges.
const MYTYPE_SECTION_PRIORITY = {
  how_i_work_best:     ['growth_adaptability', 'structure_autonomy', 'achievement_drive', 'social_collaboration'],
  what_you_may_notice: ['communication_style', 'social_collaboration', 'thinking_decision'],
  working_with_me:     ['communication_style', 'achievement_drive', 'growth_adaptability', 'social_collaboration']
};

// Safe word ceiling per assembled section. Locked down from the spec's
// original 55-90 to 55-65 after checking actual pixel budget on the final
// page-2 layout (worst case of every section hitting 90 words at once
// pushed content past a 2nd PDF page -- see chat for the full calc).
const MYTYPE_MAX_WORDS = 65;

// Gentle fallback text if a section ends up with literally nothing eligible
// (e.g. incomplete answers, or every relevant dimension landed on
// balanced/low-confidence). Keeps output non-empty without ever forcing a
// dimension into a headline it does not have the confidence to support.
const MYTYPE_FALLBACK = {
  personal_reflection: 'Your answers show a well-rounded mix across these areas, without one single trait standing far above the rest, which is its own kind of balance.',
  how_i_work_best: 'You tend to draw on a flexible mix of approaches depending on the situation, rather than leaning heavily on one working style.',
  what_you_may_notice: 'I tend to adapt my approach to the situation rather than following one fixed pattern.',
  working_with_me: 'Get to know the context, and I will meet you where it makes sense. I do not lean strongly toward one fixed style.'
};

/* ----------------------------------------------------------------------------
   4. Scoring (direct port of spec §5's TypeScript pseudocode)
   ---------------------------------------------------------------------------- */
function mteNormalize(raw, polarity) {
  return polarity === 1 ? raw : 100 - raw;
}

// Built once at load time: for each dimension, the list of {qid, polarity,
// weight} that feed it -- inverted from MYTYPE_NARRATIVE_MAP so scoring
// never has to walk all 50 questions per dimension.
function mteBuildDimensionIndex() {
  const index = {};
  MYTYPE_DIMENSIONS.forEach(function (d) { index[d] = []; });
  Object.keys(MYTYPE_NARRATIVE_MAP).forEach(function (qid) {
    const entry = MYTYPE_NARRATIVE_MAP[qid];
    if (!entry.maps) return; // preference-only question, not scoring evidence
    entry.maps.forEach(function (m) {
      index[m.dimension].push({ qid: qid, polarity: m.polarity, weight: m.weight });
    });
  });
  return index;
}
const MYTYPE_DIMENSION_INDEX = mteBuildDimensionIndex();

function mteCalculateDimension(responses, maps) {
  const values = [];
  let weightedSum = 0;
  let totalWeight = 0;

  maps.forEach(function (map) {
    const raw = responses[map.qid];
    // guardrail (spec §10): validate 0 <= raw <= 100, skip anything else
    // (covers unanswered questions -- extractAnsweredQuestions omits them
    // entirely so raw will be undefined/null here, not a bad number)
    if (raw == null || raw < 0 || raw > 100) return;
    const value = mteNormalize(raw, map.polarity);
    values.push(value);
    weightedSum += value * map.weight;
    totalWeight += map.weight;
  });

  if (!totalWeight) return null; // no answered contributing questions at all
  const score = weightedSum / totalWeight;
  return { score: score, band: mteGetBand(score), confidence: mteGetConfidence(values) };
}

function mteGetBand(score) {
  if (score < 40) return 'low';
  if (score < 65) return 'balanced';
  return 'high';
}

function mteGetConfidence(values) {
  if (values.length < 2) return 'low';
  const mean = values.reduce(function (a, b) { return a + b; }, 0) / values.length;
  const variance = values.reduce(function (s, x) { return s + Math.pow(x - mean, 2); }, 0) / values.length;
  const sd = Math.sqrt(variance);
  if (sd <= 12) return 'high';
  if (sd <= 22) return 'medium';
  return 'low';
}

function mteCalculateAllDimensions(responses) {
  const result = {};
  MYTYPE_DIMENSIONS.forEach(function (id) {
    result[id] = mteCalculateDimension(responses, MYTYPE_DIMENSION_INDEX[id]);
  });
  return result;
}

/* ----------------------------------------------------------------------------
   5. Signal selection (spec §5 "Interpretation rules" + §6 "Section signal
      priorities") -- balanced band and confidence:'low' are never headlined.
   ---------------------------------------------------------------------------- */
function mteEligible(scored) {
  return !!scored && scored.band !== 'balanced' && scored.confidence !== 'low';
}

// Top N across ALL 7 dimensions, ranked by distance from the midpoint.
// Used for both "What Stands Out" badges and the Personal Reflection /
// Personal Snapshot text (same pool, per spec §6: "Personal Reflection
// Profile | Top 3 eligible dimensions").
function mteDominantSignals(dimScores, limit) {
  return MYTYPE_DIMENSIONS
    .map(function (id) { return { id: id, d: dimScores[id] }; })
    .filter(function (x) { return mteEligible(x.d); })
    .sort(function (a, b) { return Math.abs(b.d.score - 50) - Math.abs(a.d.score - 50); })
    .slice(0, limit)
    .map(function (x) { return { id: x.id, band: x.d.band, score: x.d.score }; });
}

// Top N within a single section's priority list only (e.g. How I Work Best
// only draws from growth/structure/achievement/social, never from
// relationship_orientation or thinking_decision).
function mteChooseSectionDimensions(dimScores, priorityList, limit) {
  return priorityList
    .map(function (id) { return { id: id, d: dimScores[id] }; })
    .filter(function (x) { return mteEligible(x.d); })
    .sort(function (a, b) { return Math.abs(b.d.score - 50) - Math.abs(a.d.score - 50); })
    .slice(0, limit)
    .map(function (x) { return { id: x.id, band: x.d.band, score: x.d.score }; });
}

// Rules whose trigger dimensions are BOTH eligible (confidence != 'low') and
// match the required band. Capped globally at 2 (spec §8: "max two rules per
// entire output"), taken in the priority order the rules are listed above.
function mteSelectGlobalRules(dimScores) {
  return MYTYPE_COMBINATION_RULES.filter(function (rule) {
    return Object.keys(rule.when).every(function (dim) {
      const scored = dimScores[dim];
      return scored && scored.confidence !== 'low' && scored.band === rule.when[dim];
    });
  }).slice(0, 2);
}

/* ----------------------------------------------------------------------------
   6. Assembly -- turns selected blocks/rules into the final section text,
      always respecting MYTYPE_MAX_WORDS and never cutting mid-sentence.
   ---------------------------------------------------------------------------- */
function mteWordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Greedy pack: add sentences in priority order while staying under the cap.
// Always keeps at least the first (highest-priority) sentence, even in the
// rare case a single sentence alone exceeds the cap, so a section is never
// left empty because of a strict length check.
function mteComposeText(parts, maxWords) {
  const used = [];
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const w = mteWordCount(parts[i]);
    if (used.length === 0 || total + w <= maxWords) {
      used.push(parts[i]);
      total += w;
    }
  }
  return used.join(' ');
}

function mteBuildPersonalReflection(dominant) {
  const parts = dominant
    .map(function (d) { return MYTYPE_NARRATIVE_BLOCKS[d.id][d.band].personal; })
    .filter(Boolean);
  if (!parts.length) return MYTYPE_FALLBACK.personal_reflection;
  return mteComposeText(parts, MYTYPE_MAX_WORDS);
}

// sectionKey: 'how_i_work_best' | 'what_you_may_notice' | 'working_with_me'
// blockField: 'work' | 'notice' | 'working' (matching key inside each
// dimension's band object in MYTYPE_NARRATIVE_BLOCKS)
function mteBuildOtherSection(sectionKey, dimScores, blockField, globalRules) {
  const chosen = mteChooseSectionDimensions(dimScores, MYTYPE_SECTION_PRIORITY[sectionKey], 2);
  const ruleTexts = globalRules
    .filter(function (r) { return r.section === sectionKey; })
    .map(function (r) { return r.text; });
  const blockTexts = chosen
    .map(function (d) {
      const block = MYTYPE_NARRATIVE_BLOCKS[d.id][d.band];
      return block ? block[blockField] : null;
    })
    .filter(Boolean);
  // spec §6 assembly pseudocode order: rules first, then base blocks
  const parts = ruleTexts.concat(blockTexts);
  if (!parts.length) return MYTYPE_FALLBACK[sectionKey];
  return mteComposeText(parts, MYTYPE_MAX_WORDS);
}

function mteAssembleNarrative(responses) {
  const dimScores = mteCalculateAllDimensions(responses);
  const dominant = mteDominantSignals(dimScores, 3);
  const globalRules = mteSelectGlobalRules(dimScores);

  return {
    dimensions: dimScores,
    dominant: dominant, // feeds "What Stands Out" badges directly
    sections: {
      personal_reflection: mteBuildPersonalReflection(dominant),
      how_i_work_best: mteBuildOtherSection('how_i_work_best', dimScores, 'work', globalRules),
      what_you_may_notice: mteBuildOtherSection('what_you_may_notice', dimScores, 'notice', globalRules),
      working_with_me: mteBuildOtherSection('working_with_me', dimScores, 'working', globalRules)
    }
  };
}

/* ----------------------------------------------------------------------------
   7. Page-2 HTML renderer -- matches the locked mockup (v5) exactly:
      fixed 560x800 .mte-page, Executive Summary (badges + nested Personal
      Snapshot card), then 3 accent-bar sections, footer pinned to the
      bottom via margin-top:auto regardless of content length.
   ---------------------------------------------------------------------------- */
function mteEscapeHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) { return map[c]; });
}

function myTypeNarrativePageHtml(displayName, narrative) {
  const safeName = mteEscapeHtml(displayName || 'this person');

  const badgesHtml = narrative.dominant.map(function (d) {
    const label = MYTYPE_DIMENSION_LABELS[d.id][d.band];
    return '<div style="flex:1; background:#2143C8; border-radius:9px; padding:13px 6px; text-align:center; display:flex; align-items:center; justify-content:center;">' +
      '<span style="color:#fff; font-weight:700; font-size:12px; line-height:1.28;">' + mteEscapeHtml(label) + '</span>' +
    '</div>';
  }).join('');

  function section(title, text, isLast) {
    return '<div style="margin-bottom:' + (isLast ? '0' : '14px') + '; border-left:3px solid #B7C7EF; border-radius:0; padding-left:14px;">' +
      '<div style="font-family:\'Antonio\',sans-serif; font-weight:700; font-size:14px; color:#2143C8; letter-spacing:0.3px; margin-bottom:4px;">' + title + '</div>' +
      '<p style="font-size:11.5px; line-height:1.58; color:#33415E; margin:0;">' + mteEscapeHtml(text) + '</p>' +
    '</div>';
  }

  return (
    '<div class="mte-page" style="font-family:\'Inter\',Arial,sans-serif; color:#0B1D7F; background:#fff; padding:26px 32px; box-sizing:border-box; width:560px; height:800px; display:flex; flex-direction:column;">' +
      '<div>' +
        '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; border-bottom:1px solid #DCE4F7; padding-bottom:9px; margin-bottom:16px;">' +
          '<div>' +
            '<div style="font-family:\'Antonio\',sans-serif; font-weight:700; font-size:17px; color:#2143C8; letter-spacing:0.4px;">TOKBUD &mdash; Personal Reflection Profile</div>' +
            '<div style="font-size:10.5px; color:#5C6B9E; margin-top:3px; max-width:440px; line-height:1.4;">A snapshot of how ' + safeName + ' tends to think, work, and connect with others today.</div>' +
            '<div style="font-size:8.5px; color:#9FB0D9; margin-top:2px; max-width:440px; line-height:1.35;">People change with time, experience, and learning, so use this profile as one piece of context &mdash; especially when making important decisions.</div>' +
          '</div>' +
          '<div style="font-size:10px; color:#9FB0D9; white-space:nowrap; margin-top:2px;">Page 2 of 2</div>' +
        '</div>' +

        '<div style="margin-bottom:16px;">' +
          '<div style="font-family:\'Antonio\',sans-serif; font-weight:700; font-size:14px; color:#2143C8; letter-spacing:0.3px; margin-bottom:9px;">Executive Summary</div>' +
          '<div style="background:#F5F8FF; border-radius:10px; padding:16px;">' +
            (badgesHtml ?
              '<div style="font-size:9.5px; font-weight:600; color:#7A5C0C; letter-spacing:0.5px; text-transform:uppercase; margin-bottom:8px;">What stands out</div>' +
              '<div style="display:flex; gap:8px; margin-bottom:12px;">' + badgesHtml + '</div>'
              : '') +
            '<div style="background:#fff; border:1px solid #DCE4F7; border-radius:8px; padding:12px 14px;">' +
              '<div style="font-size:9.5px; font-weight:600; color:#7A5C0C; letter-spacing:0.5px; text-transform:uppercase; margin-bottom:6px;">Personal snapshot</div>' +
              '<p style="font-size:11.5px; line-height:1.58; color:#33415E; margin:0;">' + mteEscapeHtml(narrative.sections.personal_reflection) + '</p>' +
            '</div>' +
          '</div>' +
        '</div>' +

        section('How I work best', narrative.sections.how_i_work_best, false) +
        section('Working with me', narrative.sections.working_with_me, false) +
        section('What you may notice about me', narrative.sections.what_you_may_notice, true) +
      '</div>' +

      '<div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid #DCE4F7; padding-top:8px; margin-top:auto;">' +
        '<span style="font-size:8.5px; color:#9FB0D9;">This is a reflection tool, not a psychological assessment.</span>' +
        '<span style="font-size:9px; color:#5C6B9E;">Powered by tokbud.vercel.app</span>' +
      '</div>' +
    '</div>'
  );
}

/* ----------------------------------------------------------------------------
   8. Public entry point
   ----------------------------------------------------------------------------
   mytype.txt should call this from downloadMyTypePdf(), same place it
   currently builds page 1's HTML, and append the returned string as a
   second .mte-page element before capture.

   NOTE (integration reminder, not yet wired -- next step): spec §10 requires
   "a completed response before generating a full profile; otherwise mark
   affected dimensions incomplete." This function already degrades
   gracefully (falls back to neutral text per section) if `answers` is
   partial, but the calling UI should still decide whether to show the "See
   My Type Summary Sheet" button/modal at all before all 50 questions are
   answered -- that gate belongs in mytype.txt, not here.
   ---------------------------------------------------------------------------- */
function buildMyTypeNarrativePage(displayName, answers) {
  const narrative = mteAssembleNarrative(answers || {});
  return myTypeNarrativePageHtml(displayName, narrative);
}