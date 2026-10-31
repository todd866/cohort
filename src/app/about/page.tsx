import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { isCohortHostname } from '@/lib/institution';
import { resolveSourceRepositoryUrl } from '@/lib/source-repository';

export async function generateMetadata(): Promise<Metadata> {
  const host = (await headers()).get('host') ?? '';
  return isCohortHostname(host)
    ? { title: 'About - md3', description: 'Scope, principles, and limitations of the open md3/Cohort Step 1 alpha' }
    : { title: 'About - md3', description: 'What md3 is, who it is for, and what it is not: a personalised spaced-repetition question bank for University of Sydney MD students.' };
}

const OFFICIAL_USMLE_ABOUT = 'https://www.usmle.org/about-usmle';
const OFFICIAL_USMLE_SECURITY = 'https://www.usmle.org/what-to-know/exam-security-fairness';

function Md3About() {
  return (
    <main className="min-h-screen px-6 py-8">
      <div className="mx-auto max-w-3xl">
        <Link href="/" className="mb-4 inline-block text-sm text-[var(--md-primary)] hover:underline">
          &larr; Back to review
        </Link>
        <h1 className="mb-4 text-4xl font-bold text-[var(--md-on-surface)]">About md3</h1>
        <p className="mb-12 text-lg text-[var(--md-on-surface-variant)]">
          A personalised spaced-repetition question bank for University of Sydney MD students.
        </p>

        <div className="space-y-12 text-[var(--md-on-surface)]">
          <section>
            <h2 className="mb-4 text-2xl font-semibold">What md3 is</h2>
            <p className="leading-relaxed text-[var(--md-on-surface-variant)]">
              md3 schedules cards and questions around what you already know and what your
              rotation exams will ask. It includes practice papers with explanations and
              follow-up questions, and an AI tutor you can ask about the item in front of you.
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-semibold">Who it is for</h2>
            <p className="leading-relaxed text-[var(--md-on-surface-variant)]">
              Medical students working through clinical rotations who want regular, targeted
              revision instead of rereading notes.
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-semibold">What it is not</h2>
            <ul className="list-disc space-y-2 pl-6 text-[var(--md-on-surface-variant)]">
              <li>It is not a predictor of exam results.</li>
              <li>
                It is not affiliated with the University of Sydney or any exam body.
              </li>
              <li>
                Content is checked against Australian guidelines, but md3 is not a clinical
                reference. Check current local guidance before treating a patient.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-semibold">Report a problem</h2>
            <p className="leading-relaxed text-[var(--md-on-surface-variant)]">
              Use the flag on any card or question to describe what is wrong. Reports are read
              and acted on.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}

export default async function AboutPage() {
  if (!isCohortHostname((await headers()).get('host') ?? '')) return <Md3About />;
  const sourceRepositoryUrl = resolveSourceRepositoryUrl(
    process.env.NEXT_PUBLIC_SOURCE_REPOSITORY_URL,
  );

  return (
    <main className="min-h-screen px-6 py-8">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/usmle/step1"
          className="mb-4 inline-block text-sm text-[var(--md-primary)] hover:underline"
        >
          &larr; Back to Step 1
        </Link>
        <h1 className="mb-4 text-4xl font-bold text-[var(--md-on-surface)]">
          About md3 and Cohort
        </h1>
        <p className="mb-12 text-lg text-[var(--md-on-surface-variant)]">
          A free, open-source Step 1 study alpha built in public.
        </p>

        <div className="space-y-12 text-[var(--md-on-surface)]">
          <section>
            <h2 className="mb-4 text-2xl font-semibold">What works today</h2>
            <p className="mb-4 leading-relaxed text-[var(--md-on-surface-variant)]">
              The current open alpha is a deliberately small vertical slice: 25 original
              questions across six domains, an answer-and-explanation reveal boundary, source
              attribution, progress recording, and baseline or daily study sessions.
            </p>
            <p className="leading-relaxed text-[var(--md-on-surface-variant)]">
              It is enough to test the complete learning loop and contribution workflow. It is
              not a comprehensive Step 1 bank, complete curriculum map, score predictor, or
              substitute for current official exam information.
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-semibold">How the learning loop is designed</h2>
            <p className="mb-4 leading-relaxed text-[var(--md-on-surface-variant)]">
              Learners see the question before any answer-bearing payload. After an answer, the
              product can show the rationale, option-level feedback, and the exact source record
              used to support the item. Recorded attempts can then inform later review.
            </p>
            <p className="leading-relaxed text-[var(--md-on-surface-variant)]">
              Where an operator configures the embedding pipeline, study items can also be
              represented in semantic vector space for future scheduling research. The initial
              public USMLE corpus does not require embeddings to build or run, and this alpha
              makes no guarantee of exam-date optimisation or complete curriculum coverage.
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-semibold">Open source and open content</h2>
            {sourceRepositoryUrl ? (
              <p className="mb-4 leading-relaxed text-[var(--md-on-surface-variant)]">
                md3&apos;s reviewed source distribution is available for people to inspect, learn
                from, adapt, and contribute to. Contributor-owned software uses the MIT License;
                contributor-owned educational content uses CC BY 4.0. Exact-passages and
                third-party assets keep their recorded source-level rights.
              </p>
            ) : (
              <p className="mb-4 leading-relaxed text-[var(--md-on-surface-variant)]">
                md3&apos;s contributor-owned code and educational content are licensed for open
                reuse within its reviewed source distribution. This deployment has not yet
                published a source repository link.
              </p>
            )}
            <p className="mb-4 leading-relaxed text-[var(--md-on-surface-variant)]">
              Contributions must be original or have documented compatible rights. Recalled live
              exam content is not accepted.
            </p>
            {sourceRepositoryUrl ? (
              <a
                href={sourceRepositoryUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex rounded-full bg-[var(--md-surface-container)] px-4 py-2 text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]"
              >
                View source repository
              </a>
            ) : null}
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-semibold">Independence and exam security</h2>
            <p className="mb-4 leading-relaxed text-[var(--md-on-surface-variant)]">
              md3 and Cohort are independent educational projects. They are not affiliated with,
              endorsed by, or sponsored by the USMLE program. The software is educational only
              and is not medical advice.
            </p>
            <ul className="list-disc space-y-2 pl-6 text-[var(--md-on-surface-variant)]">
              <li>
                <a
                  href={OFFICIAL_USMLE_ABOUT}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--md-primary)] hover:underline"
                >
                  Official USMLE program overview
                </a>
              </li>
              <li>
                <a
                  href={OFFICIAL_USMLE_SECURITY}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--md-primary)] hover:underline"
                >
                  Official exam-security and fairness guidance
                </a>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
