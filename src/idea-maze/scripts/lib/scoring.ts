/**
 * Harvest scoring — ported 1:1 from idea-maze-lab scoring.py.
 *
 * Deterministic scoring of source items to rank signal quality.
 * Higher scores = stronger product-discovery signal.
 */

export interface ScoringResult {
  score: number;
  signals: string[];
  patterns: string[];
  breakdown: Record<string, number>;
}

export interface ScoreInput {
  source: string;
  author?: string | null;
  title?: string | null;
  text: string;
  canonical_url?: string | null;
  metadata?: Record<string, any>;
}

// --- Keyword term sets ---

const COMPLAINT_TERMS = new Set([
  "annoying", "blocked", "broken", "complaint", "friction",
  "hate", "issue", "missing", "pain", "problem",
  "slow", "stuck", "wish",
]);

const MANUAL_WORK_TERMS = new Set([
  "by hand", "copy paste", "copy-paste", "csv", "double entry",
  "export", "handoff", "import", "manual", "reconcile",
  "repeat", "repetitive", "spreadsheet", "stitch together",
]);

const WORKFLOW_TERMS = new Set([
  "approval", "follow up", "follow-up", "handoff", "ops",
  "pipeline", "process", "queue", "step", "workflow",
]);

const SPEND_TERMS = new Set([
  "agency", "budget", "compliance", "consultant", "contractor",
  "cost", "expensive", "freelancer", "headcount", "hire",
  "hourly", "outsource", "pay", "per project", "salary",
  "spent", "upwork",
]);

const ROUTINE_FRICTION_TERMS = new Set([
  "can't stick", "cannot stick", "fall off", "falling apart", "inconsistent",
  "keep getting stuck", "overwhelmed", "routine", "struggle", "stuck",
]);

const TRACKING_PLANNING_TERMS = new Set([
  "budget", "calendar", "checklist", "itinerary", "log", "meal prep",
  "plan", "planning", "schedule", "steps", "time blocking", "track", "tracking",
]);

const HEALTH_FITNESS_TERMS = new Set([
  "deload", "garmin", "gym", "injury", "oura", "plateau",
  "recovery", "soreness", "workout",
]);

const LEARNING_MEMORY_TERMS = new Set([
  "anki", "flashcards", "forget", "forgetting", "language learning", "memorize",
  "mnemonic", "recall", "retain", "retention", "spaced repetition",
]);

const PRODUCTIVITY_FRICTION_TERMS = new Set([
  "burnout", "distracted", "focus", "habit", "procrastinate", "procrastination",
  "task list", "todo", "to-do",
]);

const TRAVEL_LOGISTICS_TERMS = new Set([
  "booking", "carry-on", "flight", "flights", "itinerary", "onebag", "packing",
  "passport", "visa",
]);

export type RedditTopicGroup = 'health' | 'learning' | 'productivity' | 'travel' | 'other';

const HEALTH_SUBREDDITS = new Set(['r/bodyweightfitness', 'r/beginnerfitness', 'r/running', 'r/ouraring', 'r/garmin', 'r/biohackers']);
const LEARNING_SUBREDDITS = new Set(['r/getstudying', 'r/anki', 'r/memory', 'r/mnemonics', 'r/languagelearning']);
const PRODUCTIVITY_SUBREDDITS = new Set(['r/productivity', 'r/selfimprovement', 'r/decidingtobebetter']);
const TRAVEL_SUBREDDITS = new Set(['r/onebag', 'r/solotravel', 'r/digitalnomad', 'r/shoestring']);

function normalizeSubreddit(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  return raw.startsWith('r/') ? raw : `r/${raw}`;
}

export function classifyRedditTopicGroup(subreddit: unknown): RedditTopicGroup {
  const normalized = normalizeSubreddit(subreddit);
  if (HEALTH_SUBREDDITS.has(normalized)) return 'health';
  if (LEARNING_SUBREDDITS.has(normalized)) return 'learning';
  if (PRODUCTIVITY_SUBREDDITS.has(normalized)) return 'productivity';
  if (TRAVEL_SUBREDDITS.has(normalized)) return 'travel';
  return 'other';
}

function topicPerMatch(topicMatches: boolean, basePerMatch: number, boostedPerMatch: number): number {
  return topicMatches ? boostedPerMatch : basePerMatch;
}

function topicMax(topicMatches: boolean, baseMax: number, boostedMax: number): number {
  return topicMatches ? boostedMax : baseMax;
}

// --- Source pattern rules ---

const PATTERN_RULES: Record<string, { terms: Set<string>; weight: number }> = {
  "github-issues": {
    terms: new Set(["github.com", "issue #", "issues/", "pull request", "feature request"]),
    weight: 0.17,
  },
  "community-thread": {
    terms: new Set(["reddit.com", "subreddit", "r/", "comment thread", "reply", "comments"]),
    weight: 0.12,
  },
  "review-complaints": {
    terms: new Set(["1-star", "one star", "review", "chrome web store", "app store"]),
    weight: 0.16,
  },
  "outsourced-work": {
    terms: new Set(["upwork", "contractor", "freelancer", "agency", "statement of work"]),
    weight: 0.19,
  },
  "job-market": {
    terms: new Set(["must-know", "job description", "requirements", "responsibilities", "job listing"]),
    weight: 0.16,
  },
  "changelog-migration": {
    terms: new Set(["changelog", "migration", "breaking change", "deprecated", "deprecation", "sunset"]),
    weight: 0.16,
  },
  "templates-and-ops": {
    terms: new Set(["zapier", "template", "notion", "spreadsheet", "google sheet", "airtable"]),
    weight: 0.15,
  },
  "support-workflow": {
    terms: new Set(["support", "ticket", "customer support", "sla", "triage"]),
    weight: 0.14,
  },
  "promotional": {
    terms: new Set(["product hunt", "sign up", "paid plans", "free startup idea", "creative juices"]),
    weight: -0.18,
  },
  "hype-derivative": {
    terms: new Set(["ai for ", "agent for ", "research paper", "adjacent product ideas", "search volume"]),
    weight: -0.16,
  },
  "megathread-noise": {
    terms: new Set(["megathread", "weekly thread", "daily thread", "bag finder megathread"]),
    weight: -0.16,
  },
  "motivation-only": {
    terms: new Set(["you can do it", "believe in yourself", "success story", "i made it", "thank you community"]),
    weight: -0.12,
  },
  "showcase-only": {
    terms: new Set(["my setup", "rate my", "review my fit", "what would you optimize"]),
    weight: -0.08,
  },
};

// --- Scoring functions ---

function normalizeScoringText(text: string): string {
  return text
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39);/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function boundedKeywordScore(haystack: string, terms: Set<string>, perMatch: number, maxScore: number): number {
  let matches = 0;
  for (const term of terms) {
    if (haystack.includes(term)) matches++;
  }
  return Math.round(Math.min(maxScore, matches * perMatch) * 1000) / 1000;
}

function engagementScore(source: string, metadata: Record<string, any>): number {
  if (source === "telegram") {
    const replies = Math.max(0, Number(metadata.reply_count) || 0);
    const forwards = Math.max(0, Number(metadata.forwards) || 0);
    const views = Math.max(0, Number(metadata.views) || 0);

    let score = 0;
    if (replies) score += Math.min(0.08, 0.02 * replies);
    if (forwards) score += Math.min(0.05, 0.01 * forwards);
    if (views) score += Math.min(0.05, Math.log10(views + 1) * 0.015);
    return Math.round(Math.min(0.15, score) * 1000) / 1000;
  }

  if (source === "reddit") {
    const postScore = Math.max(0, Number(metadata.score) || 0);
    const numComments = Math.max(0, Number(metadata.num_comments) || 0);
    const upvoteRatio = Number(metadata.upvote_ratio) || 0;

    let score = 0;
    if (numComments) score += Math.min(0.08, Math.log10(numComments + 1) * 0.05);
    if (postScore) score += Math.min(0.05, Math.log10(postScore + 1) * 0.02);
    if (upvoteRatio > 0.5) score += Math.min(0.03, (upvoteRatio - 0.5) * 0.06);
    return Math.round(Math.min(0.15, score) * 1000) / 1000;
  }

  return 0;
}

function commentCount(source: string, metadata: Record<string, any>): number {
  if (source === "telegram") return Math.max(0, Number(metadata.reply_count) || 0);
  if (source === "reddit") return Math.max(0, Number(metadata.num_comments) || 0);
  return 0;
}

export function scoreSourceItem(input: ScoreInput): ScoringResult {
  const metadata = input.metadata ?? {};
  const haystack = normalizeScoringText([
    input.author ?? "",
    input.title ?? "",
    input.text,
    input.canonical_url ?? "",
    metadata.snippet ?? "",
    metadata.subreddit ?? "",
    metadata.link_flair_text ?? "",
  ]
    .filter(Boolean)
    .join(" \n"));

  const topicGroup = input.source === 'reddit'
    ? classifyRedditTopicGroup(metadata.subreddit ?? metadata.channel_or_label ?? metadata.subreddit_name)
    : 'other';

  const patterns: string[] = [];
  const signals: string[] = [];
  const breakdown: Record<string, number> = {};
  let score = 0.15;

  // Keyword categories
  const complaintScore = boundedKeywordScore(haystack, COMPLAINT_TERMS, 0.05, 0.2);
  if (complaintScore) {
    breakdown.complaint_language = complaintScore;
    signals.push("complaint-language");
    score += complaintScore;
  }

  const manualScore = boundedKeywordScore(haystack, MANUAL_WORK_TERMS, 0.06, 0.22);
  if (manualScore) {
    breakdown.manual_work = manualScore;
    signals.push("manual-work");
    score += manualScore;
  }

  const workflowScore = boundedKeywordScore(haystack, WORKFLOW_TERMS, 0.05, 0.16);
  if (workflowScore) {
    breakdown.workflow_chain = workflowScore;
    signals.push("workflow-context");
    score += workflowScore;
  }

  const spendScore = boundedKeywordScore(haystack, SPEND_TERMS, 0.05, 0.18);
  if (spendScore) {
    breakdown.existing_spend = spendScore;
    signals.push("existing-spend");
    score += spendScore;
  }

  const routineTopicMatch = topicGroup === 'health' || topicGroup === 'productivity';
  const routineScore = boundedKeywordScore(
    haystack,
    ROUTINE_FRICTION_TERMS,
    topicPerMatch(routineTopicMatch, 0.045, 0.06),
    topicMax(routineTopicMatch, 0.16, 0.18),
  );
  if (routineScore) {
    breakdown.routine_friction = routineScore;
    signals.push("routine-friction");
    score += routineScore;
  }

  const trackingTopicMatch = topicGroup === 'learning' || topicGroup === 'travel';
  const trackingScore = boundedKeywordScore(
    haystack,
    TRACKING_PLANNING_TERMS,
    topicPerMatch(trackingTopicMatch, 0.04, 0.05),
    topicMax(trackingTopicMatch, 0.14, 0.16),
  );
  if (trackingScore) {
    breakdown.tracking_planning = trackingScore;
    signals.push("tracking-planning");
    score += trackingScore;
  }

  const healthScore = boundedKeywordScore(
    haystack,
    HEALTH_FITNESS_TERMS,
    topicPerMatch(topicGroup === 'health', 0.035, 0.06),
    topicMax(topicGroup === 'health', 0.12, 0.18),
  );
  if (healthScore) {
    breakdown.health_fitness = healthScore;
    signals.push("health-fitness");
    score += healthScore;
  }

  const learningScore = boundedKeywordScore(
    haystack,
    LEARNING_MEMORY_TERMS,
    topicPerMatch(topicGroup === 'learning', 0.035, 0.06),
    topicMax(topicGroup === 'learning', 0.12, 0.18),
  );
  if (learningScore) {
    breakdown.learning_memory = learningScore;
    signals.push("learning-memory");
    score += learningScore;
  }

  const productivityScore = boundedKeywordScore(
    haystack,
    PRODUCTIVITY_FRICTION_TERMS,
    topicPerMatch(topicGroup === 'productivity', 0.035, 0.06),
    topicMax(topicGroup === 'productivity', 0.12, 0.18),
  );
  if (productivityScore) {
    breakdown.productivity_friction = productivityScore;
    signals.push("productivity-friction");
    score += productivityScore;
  }

  const travelScore = boundedKeywordScore(
    haystack,
    TRAVEL_LOGISTICS_TERMS,
    topicPerMatch(topicGroup === 'travel', 0.035, 0.06),
    topicMax(topicGroup === 'travel', 0.12, 0.18),
  );
  if (travelScore) {
    breakdown.travel_logistics = travelScore;
    signals.push("travel-logistics");
    score += travelScore;
  }

  // Source pattern matching
  for (const [patternName, rule] of Object.entries(PATTERN_RULES)) {
    for (const term of rule.terms) {
      if (haystack.includes(term)) {
        patterns.push(patternName);
        breakdown[`pattern:${patternName}`] = rule.weight;
        score += rule.weight;
        break;
      }
    }
  }

  // Engagement scoring
  const engagement = engagementScore(input.source, metadata);
  if (engagement) {
    breakdown.engagement = engagement;
    signals.push("public-engagement");
    score += engagement;
  }

  // Comment thread bonus
  const comments = commentCount(input.source, metadata);
  if (comments) {
    const commentBonus = Math.min(0.08, 0.02 * comments);
    breakdown.comment_thread = commentBonus;
    signals.push("comment-thread");
    score += commentBonus;
  }

  // Extra penalties for weak/noisy signal patterns
  const signalSet = new Set(signals);
  if (
    patterns.includes("promotional") &&
    !signalSet.has("complaint-language") &&
    !signalSet.has("manual-work") &&
    !signalSet.has("workflow-context")
  ) {
    breakdown.promotion_penalty = -0.08;
    signals.push("weak-pain-evidence");
    score -= 0.08;
  }

  if (patterns.includes("hype-derivative") && !signalSet.has("complaint-language")) {
    breakdown.derivative_penalty = -0.07;
    signals.push("derivative-source");
    score -= 0.07;
  }

  const hasConcretePain = signalSet.has("complaint-language") || signalSet.has("routine-friction");
  if (patterns.includes("megathread-noise") && !hasConcretePain) {
    breakdown.daily_routine_noise_penalty = -0.08;
    signals.push("weak-pain-evidence");
    score -= 0.08;
  }

  if (patterns.includes("motivation-only") && !hasConcretePain) {
    breakdown.motivation_penalty = -0.05;
    signals.push("weak-pain-evidence");
    score -= 0.05;
  }

  if (patterns.includes("showcase-only") && !hasConcretePain) {
    breakdown.showcase_penalty = -0.22;
    signals.push("weak-pain-evidence");
    score -= 0.22;
  }

  const normalized = Math.round(Math.max(0.05, Math.min(1.0, score)) * 1000) / 1000;

  return {
    score: normalized,
    signals: [...new Set(signals)].sort(),
    patterns: [...new Set(patterns)].sort(),
    breakdown,
  };
}
