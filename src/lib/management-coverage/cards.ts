export async function loadCardIdsFromGeneratedContentMaps(): Promise<{
  cardIds: Set<string>;
  errors: string[];
}> {
  try {
    const { ROTATION_CONTENT_LOADERS } = await import('../generated/content-map-rotations');
    const loadedMaps = await Promise.all(Object.values(ROTATION_CONTENT_LOADERS).map((loadRotation) => loadRotation()));
    const cardIds = new Set<string>();

    for (const rotationMap of loadedMaps) {
      for (const cardId of Object.keys(rotationMap.cards)) {
        cardIds.add(cardId);
      }
    }

    return { cardIds, errors: [] };
  } catch (error) {
    return {
      cardIds: new Set<string>(),
      errors: [
        `generated content maps unavailable (${error instanceof Error ? error.message : 'unknown error'})`,
      ],
    };
  }
}
