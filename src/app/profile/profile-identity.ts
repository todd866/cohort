export interface FeedProfileExplicit {
  studying?: string;
  year?: string;
  school?: string;
  /**
   * What the learner is aiming to specialise in, in their own words.
   *
   * Requested 2026-09-12: worth having data on what learners are actually
   * aiming to do. Deliberately free text rather
   * than a picker: the three known answers so far are "psychiatry / GP /
   * neurosurgery", "emergency" and "cardiothoracic surgery, or cardiology or
   * ED if not surgery" — none of which a single-select would have captured
   * without flattening the fallback, which is the interesting half.
   *
   * Unlike `rotation`, which is transient by design, this is durable, so it is
   * the one targeting signal a learner outside the USyd cohort still has.
   */
  aiming?: string;
}

export interface ProfileIdentity {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  studyGoal: number | null;
  feedProfileExplicit: FeedProfileExplicit;
}

interface ProfileIdentitySource {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  studyGoal: number | null;
  feedProfile: unknown;
}

export function toProfileIdentity(user: ProfileIdentitySource): ProfileIdentity {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    studyGoal: user.studyGoal,
    feedProfileExplicit: explicitProfile(user.feedProfile),
  };
}

function explicitProfile(value: unknown): FeedProfileExplicit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const feed = value as Record<string, unknown>;
  const explicit = feed.explicit;
  if (!explicit || typeof explicit !== 'object' || Array.isArray(explicit)) return {};
  const fields = explicit as Record<string, unknown>;

  return {
    studying: typeof fields.studying === 'string' ? fields.studying : undefined,
    year: typeof fields.year === 'string' ? fields.year : undefined,
    school: typeof fields.school === 'string' ? fields.school : undefined,
    aiming: typeof fields.aiming === 'string' ? fields.aiming : undefined,
  };
}
