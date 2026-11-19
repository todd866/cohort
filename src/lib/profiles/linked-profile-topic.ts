/** The public build has no linked profiles, so no profile narrows a deck to a topic. */
export async function linkedProfileTopicsFilterForLearner(_learnerId: string): Promise<string | null> {
  void _learnerId;
  return null;
}
