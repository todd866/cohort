export interface RotationTopic {
  id: string;
  label: string;
}

/** Public build carries no private institution rotation topic catalogue. */
export function rotationTopicCatalog(_rotation: string): readonly RotationTopic[] | null {
  void _rotation;
  return null;
}
