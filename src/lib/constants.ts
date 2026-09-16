/**
 * Shared configuration constants extracted from API routes and components.
 *
 * Only values that appear in 2+ places or are clearly tuneable configuration
 * belong here. Truly one-off, self-documenting values stay in their source file.
 */

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

/** Minimum batch size for feed requests. */
export const FEED_PAGE_SIZE_MIN = 1;

/** Maximum batch size for feed requests. */
export const FEED_PAGE_SIZE_MAX = 20;

/** Default batch size when no `size` param is provided. */
export const FEED_PAGE_SIZE_DEFAULT = 8;

/** Default video-to-content ratio in the feed (4 videos per 12 slots). */
export const FEED_DEFAULT_VIDEO_RATIO = 4 / 12;

/** Default meme ratio within video slots. */
export const FEED_DEFAULT_MEME_RATIO = 0.25;

/**
 * Seriousness score below which a video is classified as a meme.
 * Used in both the feed API and the video manifold scorer.
 */
export const MEME_SERIOUSNESS_THRESHOLD = 0.4;

/** Rotations shown to anonymous / unfiltered users on the landing feed. */
export const FEED_ENGAGING_ROTATIONS = ['paam', 'critical-care'] as const;

/** Rate limit: max feed requests per window. */
export const FEED_RATE_LIMIT_MAX = 120;

/** Rate limit: window duration in ms (1 minute). */
export const FEED_RATE_LIMIT_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Questions / MCQs
// ---------------------------------------------------------------------------

/** Maximum questions returned per page embed request. */
export const MCQ_PER_PAGE_MAX = 10;

/** Maximum candidates fetched for variant question selection. */
export const VARIANT_CANDIDATE_LIMIT = 20;

// ---------------------------------------------------------------------------
// Deep-dive chat
// ---------------------------------------------------------------------------

/** Max characters of deep-dive MDX content injected into the system prompt. */
export const CHAT_MAX_CONTEXT_CHARS = 3000;

/** Max characters allowed in a single user message. */
export const CHAT_MAX_MESSAGE_CHARS = 2000;

/** Max chat response tokens from the LLM. */
export const CHAT_MAX_RESPONSE_TOKENS = 500;

/** Guest rate limit: messages per hour. */
export const CHAT_GUEST_LIMIT_PER_HOUR = 3;

/** Authenticated user rate limit: messages per day. */
export const CHAT_AUTH_LIMIT_PER_DAY = 30;

/** Max recent messages sent as conversation context. */
export const CHAT_MAX_HISTORY_MESSAGES = 10;

/** Hard deadline for the external model request. */
export const CHAT_REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Standard page size for list endpoints (due items, attempts, etc.). */
export const DEFAULT_PAGE_SIZE = 20;

/** Upper bound for page-size params on due-item endpoints. */
export const MAX_PAGE_SIZE = 50;

/** Large fetch size for candidate pools and event history. */
export const LARGE_QUERY_SIZE = 50;

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

/** OpenAI text-embedding-3-small dimension. */
export const EMBEDDING_DIM_OPENAI = 1536;

/** Gemini multimodal embedding dimension (3072-dim halfvec in DB). */
export const EMBEDDING_DIM_GEMINI = 3072;
