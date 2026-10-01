import { ROTATION_CONTENT_LOADERS, type RotationContentMap } from '@/lib/generated/content-map-rotations';

export interface LoadedRotationContent extends RotationContentMap {
  cardList: RotationContentMap['cards'][string][];
  questionList: RotationContentMap['questions'][string][];
}

const rotationContentCache = new Map<string, Promise<LoadedRotationContent>>();

async function loadRotationContent(rotation: string): Promise<LoadedRotationContent> {
  const loader = ROTATION_CONTENT_LOADERS[rotation];
  if (!loader) {
    return {
      cards: {},
      questions: {},
      cardList: [],
      questionList: [],
    };
  }

  const content = await loader();
  return {
    ...content,
    cardList: Object.values(content.cards),
    questionList: Object.values(content.questions),
  };
}

export function getRotationContent(rotation: string): Promise<LoadedRotationContent> {
  // Only generated rotations belong in the process cache. Arbitrary/missing
  // keys must not accumulate empty entries (or invoke Object.prototype keys).
  if (!Object.hasOwn(ROTATION_CONTENT_LOADERS, rotation)) {
    return Promise.resolve({ cards: {}, questions: {}, cardList: [], questionList: [] });
  }
  const cached = rotationContentCache.get(rotation);
  if (cached) return cached;

  const pending = loadRotationContent(rotation).catch((error) => {
    // A failed load started before clear() must not evict its replacement.
    if (rotationContentCache.get(rotation) === pending) rotationContentCache.delete(rotation);
    throw error;
  });
  rotationContentCache.set(rotation, pending);
  return pending;
}

export function clearRotationContentCache(): void {
  rotationContentCache.clear();
}
