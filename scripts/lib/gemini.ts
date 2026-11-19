import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from 'dotenv';
import path from 'path';

// Load env vars
const root = path.resolve(__dirname, '../../');
config({ path: path.join(root, '.env.local') });
config({ path: path.join(root, '.env') });

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error('GEMINI_API_KEY is not set in environment variables');
}

export const genAI = new GoogleGenerativeAI(apiKey);

/**
 * Stored vector-space label. Existing feedback_search_embeddings rows,
 * calibration rows and exam-target snapshots are keyed on this string and
 * must not change without a migration.
 */
export const EMBEDDING_MODEL = 'gemini-embedding-2-preview';

/** API model id sent to Google. Same vector space as EMBEDDING_MODEL. */
export const EMBEDDING_API_MODEL = 'gemini-embedding-2';

export const EMBEDDING_DIMENSIONS = 3072;
