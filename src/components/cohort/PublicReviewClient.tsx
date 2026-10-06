'use client';

import Link from 'next/link';
import { ImageBlurToggle } from '@/components/media/ImageBlurToggle';
import { ReviewOptions } from '@/components/shared/ReviewOptions';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { ConfidenceButtons } from '@/components/shared/ConfidenceButtons';
import { ReviewCardBody, ReviewCardContent, ReviewExplanation } from '@/components/shared/ReviewCardContent';
import { ReviewQuestionContent, ReviewQuestionOptions, ReviewQuestionResultBody } from '@/components/shared/ReviewQuestionContent';
import { ReviewToolbar } from '@/components/shared/ReviewToolbar';
import { ReviewActionBar } from '@/components/shared/ReviewActionBar';
import { ReviewModulePicker } from '@/components/shared/ReviewModulePicker';
import { ReviewDifficultyControl } from '@/components/shared/ReviewDifficultyControl';
import { CohortPrompt } from '@/components/shared/CohortPrompt';
import { useReviewKeyboard } from '@/components/shared/useReviewKeyboard';
import { PublicReviewFigure, preparePublicReviewFigure } from '@/components/shared/PublicReviewFigure';
import { ReviewQuestionStem, ReviewQuestionStemTable, parseReviewQuestionStem } from '@/components/shared/ReviewQuestionStem';
import { AnatomyReviewFigure, prepareAnatomyFigure } from '@/components/shared/AnatomyReviewFigure';
import { reviewShellWidthClass } from '@/components/shared/review-pane-layout';
import { useReviewDifficulty } from '@/hooks/useReviewDifficulty';
import { genClientRequestId } from '@/lib/client-request-id';
import { fetchWithDeadline, CLIENT_FETCH_DEADLINE_MS, STUDY_SESSION_FETCH_DEADLINE_MS } from '@/lib/fetch-with-deadline';
import { isCohortCardSessionItem, parseCohortCardSessionItem, parseCohortChallengeExhaustion, type CohortTurnItem, type CohortTurnResult } from '@/lib/cohort/card-turn-contract';
import type { Step1AnswerReveal } from '@/lib/usmle/step1-contract';
import { cohortReviewHref } from '@/lib/cohort/review-intent';
import type { PublicReviewProfile } from './PublicReviewEntry';
import { PublicReviewFeedback } from './PublicReviewFeedback';

function newId() { return genClientRequestId(); }
function parseTurn(value: unknown): CohortTurnResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid study turn');
  const body = value as CohortTurnResult;
  if (!Array.isArray(body.items) || ![1,3].includes(body.requestedSize) || body.deliveredSize !== body.items.length || (body.deliveredSize !== 0 && body.deliveredSize !== body.requestedSize) || typeof body.sessionId !== 'string') throw new Error('Invalid study turn');
  for (const item of body.items) {
    if (isCohortCardSessionItem(item)) {
      if (!parseCohortCardSessionItem(item)) throw new Error('Invalid study card');
    } else if (!item || typeof item.deliveryId !== 'string' || typeof item.stem !== 'string' || !Array.isArray(item.options) || !item.options.length || item.options.some(option => typeof option.label !== 'string' || !option.label.trim() || typeof option.text !== 'string' || !option.text.trim()) || new Set(item.options.map(option => option.label)).size !== item.options.length) throw new Error('Invalid study question');
  }
  return body;
}

async function prepareItem(item: CohortTurnItem) {
  if (isCohortCardSessionItem(item)) {
    if (item.media) {
      await prepareAnatomyFigure(item.media.target, item.media.role === 'supplementary' ? 'answer' : 'prompt', item.media.figureId);
      void prepareAnatomyFigure(item.media.target, 'answer', item.media.figureId).catch(() => {});
    }
  } else if (item.media) {
    await preparePublicReviewFigure(item.media.imageUrl);
  }
}

/** Public delivery adapter. All modules share this state machine and MD3's body/controls. */
export function PublicReviewClient({topicId, snapshot, onProfile}: {topicId: string | null; snapshot: PublicReviewProfile; onProfile: (snapshot: PublicReviewProfile) => void}) {
  const feedback = useRef<{rate:(rating:'good'|'bad')=>void}>(null);
  const router = useRouter();
  const {status: authStatus} = useSession();
  const [queue, setQueue] = useState<CohortTurnItem[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [answer, setAnswer] = useState<Step1AnswerReveal | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [skip, setSkip] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [figureReady, setFigureReady] = useState(true);
  const [flagOpen, setFlagOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const request = useRef<AbortController | null>(null);
  const journey = useRef(newId());
  const ordinal = useRef(0);
  const previous = useRef<string | null>(null);
  const pendingTurn = useRef<Record<string, unknown> | null>(null);
  const pendingWrite = useRef<{url: string; body: Record<string, unknown>} | null>(null);
  const pendingProfile = useRef<Record<string, unknown> | null>(null);
  const finished = useRef<string | null>(null);
  const busy = useRef(false);
  const profileBusy = useRef(false);
  const turnBusy = useRef(false);
  const startedAt = useRef(Date.now());
  const hookBatch = useRef(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const nextRef = useRef<() => Promise<void>>(async () => {});
  const automaticEase = useRef(false);
  const resumeAfterTurn = useRef(false);
  const difficulty = useReviewDifficulty({enabled: authStatus === 'authenticated', endpoint: '/api/cohort/difficulty', onApplied: async () => {
    if (automaticEase.current) {
      automaticEase.current = false;
      if (turnBusy.current) resumeAfterTurn.current = true;
      else await nextRef.current();
    }
  }});
  const difficultyRef = useRef(difficulty);
  difficultyRef.current = difficulty;

  const loadNext = useCallback(async () => {
    if (turnBusy.current || !request.current || request.current.signal.aborted) return;
    turnBusy.current = true;
    const signal = request.current.signal;
    setLoading(true); setError(null);
    const body = pendingTurn.current ?? {serveRequestId: newId(), journeyId: journey.current, nextDrawOrdinal: ordinal.current, ...(previous.current ? {previousDeliveryId: previous.current} : {}), ...(topicId ? {searchTopicId: topicId} : {}), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone};
    pendingTurn.current = body;
    try {
      const response = await fetchWithDeadline('/api/cohort/turn', {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body), signal}, STUDY_SESSION_FETCH_DEADLINE_MS);
      const raw = await response.json();
      if (!response.ok) throw new Error(`${raw.error || 'Could not prepare review'}${response.status === 429 ? ` — retry after ${response.headers.get('Retry-After') || 'a few'} seconds` : ''}`);
      const result = parseTurn(raw);
      if (result.sessionId !== journey.current) throw new Error('Unexpected study session');
      if (signal.aborted) return;
      if (!result.deliveredSize) {
        const exhaustion = parseCohortChallengeExhaustion(result.reviewChallengeExhausted);
        pendingTurn.current = null;
        if (exhaustion) {
          automaticEase.current = true;
          difficultyRef.current.easeAfterExhaustion(exhaustion);
          setError('Hard questions are exhausted. Preparing an easier question…');
        } else { setComplete(true); setQueue([]); }
        return;
      }
      await prepareItem(result.items[0]);
      if (signal.aborted) return;
      hookBatch.current = result.requestedSize === 3 && !snapshotRef.current.profile.hookCompletedAt;
      pendingTurn.current = null;
      finished.current = null;
      setQueue(result.items); setIndex(0); setSelected(null); setSkip(false); setRevealed(false); setAnswer(null); setExpanded(new Set()); setFlagOpen(false); setComplete(false);
      setFigureReady(!result.items[0].media || (isCohortCardSessionItem(result.items[0]) ? result.items[0].media.role === 'supplementary' : result.items[0].media.showWhen === 'after-reveal'));
      startedAt.current = Date.now();
      if (result.items[1]) void prepareItem(result.items[1]).catch(() => {});
    } catch (cause) { if (!signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not prepare review'); }
    finally { if (!signal.aborted) {
      turnBusy.current = false; setLoading(false);
      if (resumeAfterTurn.current) {resumeAfterTurn.current = false; void nextRef.current();}
    } }
  }, [topicId]);
  nextRef.current = loadNext;

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    turnBusy.current = false;
    queueMicrotask(() => {
      const profile = snapshotRef.current.profile;
      if (!controller.signal.aborted && (!profile.hookCompletedAt || profile.explicit.experience)) void loadNext();
    });
    return () => { controller.abort(); };
  }, [loadNext]);

  const saveProfile = async (patch: Record<string, unknown>) => {
    if (profileBusy.current || !request.current) return false;
    profileBusy.current = true;
    const signal = request.current.signal;
    pendingProfile.current = patch;
    setProfileSaving(true); setError(null);
    try {
      const response = await fetchWithDeadline('/api/cohort/profile', {method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(patch), signal}, CLIENT_FETCH_DEADLINE_MS);
      const body = await response.json();
      if (!response.ok || !body.profile) throw new Error(body.error || 'Could not save your choice');
      if (signal.aborted) return false;
      pendingProfile.current = null; onProfile({...snapshotRef.current, ...body});
      snapshotRef.current = {...snapshotRef.current, ...body};
      if (patch.experience && !queue.length) void loadNext();
      return true;
    } catch (cause) {if (!signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not save your choice'); return false;}
    finally {if (!signal.aborted) {profileBusy.current = false; setProfileSaving(false);}}
  };

  const item = queue[index];
  const card = isCohortCardSessionItem(item);
  const profileGate = Boolean(snapshot.profile.hookCompletedAt && !snapshot.profile.explicit.experience);
  const finalHook = hookBatch.current && index === queue.length - 1;
  const demandGate = Boolean(answer && snapshot.deep && snapshot.profile.explicit.experience && !snapshot.profile.explicit.demand && !finalHook);
  const blocked = loading || saving || profileSaving || profileGate || demandGate || Boolean(pendingProfile.current) || !figureReady;

  async function persistAnswer(confidence: number) {
    if (!item || busy.current || finished.current === item.deliveryId || blocked || (!card && !selected && !skip)) return;
    if (card && !revealed) return;
    busy.current = true; setSaving(true); setError(null);
    const signal = request.current!.signal;
    const write = pendingWrite.current ?? {url: card ? '/api/cohort/card-grade' : '/api/cohort/answer', body: {deliveryId: item.deliveryId, confidence, responseTimeMs: Math.max(0,Date.now()-startedAt.current), ...(card ? {clientRequestId:newId()} : {selectedDisplayLabel:selected})}};
    pendingWrite.current = write;
    try {
      const response = await fetchWithDeadline(write.url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(write.body),signal},CLIENT_FETCH_DEADLINE_MS);
      const body = await response.json();
      if (!response.ok || (!card && (!body.answer || body.answer.deliveryId !== item.deliveryId || !item.options.some(option => option.label === body.answer.correctDisplayLabel)))) throw new Error(body.error || 'Your answer could not be saved');
      if (signal.aborted) return;
      pendingWrite.current = null;
      if (card) { await advance(); }
      else {
        if (item.media?.showWhen === 'after-reveal') setFigureReady(false);
        setAnswer(body.answer); setRevealed(true);
        if (finalHook && !snapshot.profile.hookCompletedAt) await saveProfile({hookCompleted:true});
      }
    } catch (cause) {if (!signal.aborted) setError(cause instanceof Error ? cause.message : 'Your answer could not be saved');}
    finally {if (!signal.aborted) {busy.current=false;setSaving(false);}}
  }
  async function advance() {
    if (!item || loading || request.current?.signal.aborted) return;
    if (finished.current !== item.deliveryId) {finished.current = item.deliveryId; previous.current = item.deliveryId; ordinal.current += 1;}
    if (index + 1 < queue.length) {
      setLoading(true);
      try {
        const next = queue[index+1]; await prepareItem(next);
        if (request.current?.signal.aborted) return;
        setIndex(index+1); setSelected(null); setSkip(false);setAnswer(null);setRevealed(false);setExpanded(new Set());setFlagOpen(false);finished.current=null;
        setFigureReady(!next.media || (isCohortCardSessionItem(next) ? next.media.role === 'supplementary' : next.media.showWhen === 'after-reveal'));startedAt.current=Date.now();
      } catch {setError('The next picture could not be prepared. Retry to continue.');}
      finally {if (!request.current?.signal.aborted) setLoading(false);}
    } else await loadNext();
  }
  const revealCard = () => { if (card && item.media) setFigureReady(false); setRevealed(true); };
  const result = answer ? {isCorrect:answer.isCorrect,correctOption:answer.correctDisplayLabel} : null;
  useReviewKeyboard({currentItem:item ? {type:card ? 'card' : 'question',options:card ? undefined : item.options} : undefined, disabled:blocked || optionsOpen || Boolean(pendingWrite.current), cardFullyRevealed:revealed,mcqResult:result,flagMode:flagOpen,setFlagMode:setFlagOpen,handleReveal:revealCard,handleCardGrade:level=>void persistAnswer(level),cardGradeBlocked:finished.current===item?.deliveryId,handleCardContinue:()=>{if (!blocked && finished.current===item?.deliveryId) void advance();},handleSelectOption:setSelected,handleMcqSkip:()=>{setSelected(null);setSkip(true);},handleNext:()=>{if (!blocked) void advance();},handleMcqGrade:level=>{if (!answer) void persistAnswer(level);},handleContentRating:rating=>feedback.current?.rate(rating),handleVideoRate:()=>{},handleVideoContinue:()=>{},handleGoBack:()=>{},awaitingConfidence:!card && (Boolean(selected)||skip)});
  const showMedia = Boolean(item && (card ? item.media && (item.media.role === 'prompt' || revealed) : item.media && (item.media.showWhen === 'always' || revealed)));
  const figure = showMedia && item && (card ? <AnatomyReviewFigure key={item.deliveryId} figureId={item.media!.figureId} target={item.media!.target} revealed={revealed} alt={revealed ? item.media!.postAnswerAlt : item.media!.preAnswerAlt} onReady={setFigureReady} /> : <PublicReviewFigure key={item.deliveryId} src={item.media!.imageUrl} alt={answer?.postAnswerAlt || item.media!.preAnswerAlt} attribution={item.media!.attributionText} licenseUrl={item.media!.licenseUrl} onReady={setFigureReady}/>);
  const stemTables = item && !card ? parseReviewQuestionStem(item.stem) : null;
  const questionSidePane = showMedia || Boolean(stemTables?.liftTables);
  const controls = <ReviewToolbar><div className="flex min-w-0 items-center gap-2"><Link href="/usmle/step1" aria-label="Plan a study session" className="shrink-0 whitespace-nowrap text-xs text-[var(--md-primary)]">Plan</Link><div className="min-w-0 max-w-[28vw]"><ReviewModulePicker options={snapshot.searchTopics.map(topic=>({id:topic.id,label:topic.label}))} value={topicId} onChange={next=>{const href=cohortReviewHref(window.location.href,next,snapshot.searchTopics);if(href) router.push(href);}} /></div></div><div className="ml-auto flex shrink-0 items-center gap-[6px]">{authStatus==='authenticated' && <ReviewDifficultyControl value={difficulty.level} onCommit={difficulty.commit} pending={difficulty.pending} ready={difficulty.ready} adjustment={difficulty.adjustment} error={difficulty.error} onRetry={difficulty.retry} />}<button type="button" aria-label="Flag content" className="min-h-11 px-2 text-sm" disabled={!item} onClick={()=>setFlagOpen(value=>!value)}>⚐ <span className="text-xs">Flag</span></button><ReviewOptions onOpenChange={setOptionsOpen}><ImageBlurToggle/><Link href="/tech" className="text-xs underline">How it’s built</Link></ReviewOptions></div></ReviewToolbar>;
  return <main>
    {controls}
    <div data-review-content className="px-4 py-5 sm:px-6 sm:py-7 pb-40"><div className={`${reviewShellWidthClass(card ? showMedia : questionSidePane,card?'prompt-card':'prompt-question')} mx-auto review-card-shell`}>
    {error && <p role="alert" className="mb-3 text-[var(--md-error)]">{error} <button className="min-h-11 underline" disabled={loading||saving||profileSaving} onClick={()=>{if(pendingProfile.current)void saveProfile(pendingProfile.current);else if(pendingWrite.current)void persistAnswer(Number(pendingWrite.current.body.confidence));else if(finished.current)void advance();else void loadNext();}}>Retry</button></p>}
    {complete && <p role="status">This module is complete for now. Choose another module to keep studying.</p>}
    {!item && !complete && !profileGate && <p role="status">Preparing review…</p>}
    {item && <article aria-busy={loading||saving}>
      {card ? <ReviewCardContent layout={showMedia?'prompt':'flat'} compactPrompt={showMedia} stem={<ReviewCardBody front={item.front} answers={[item.back]} revealedBlanks={revealed?1:0} revealed={revealed} reserveRevealSpace={showMedia} />} answer={revealed && item.context ? <ReviewExplanation text={item.context}/> : null} media={figure} links={revealed ? <details className="mt-3 text-xs text-[var(--md-on-surface-variant)]"><summary>Source</summary>{item.attribution.text} · {item.attribution.licence}</details>:null} /> : <ReviewQuestionContent layout={questionSidePane?'prompt':'flat'} stem={<ReviewQuestionStem text={stemTables?.liftTables ? stemTables.prose : item.stem}/>} media={<>{stemTables?.liftTables && <ReviewQuestionStemTable text={item.stem}/>} {figure}</>} options={<ReviewQuestionOptions options={item.options.map(option=>({...option,explanation:answer?.optionExplanations.find(value=>value.label===option.label)?.explanation}))} selectedOption={selected} result={result} disabled={blocked||Boolean(pendingWrite.current)} selectedPending={Boolean(selected)||skip} onSelect={setSelected} onReveal={()=>{setSelected(null);setSkip(true);}} revealLabel="Show answer" expandedExplanations={expanded} onToggleExplanation={label=>setExpanded(current=>{const next=new Set(current);if(next.has(label))next.delete(label);else next.add(label);return next;})} />} result={result && <ReviewQuestionResultBody result={result} explanation={answer?.explanation}/>} tail={answer && <details className="mt-3 text-xs"><summary>Source</summary>{answer.attribution.text} · {answer.attribution.licence}{answer.citation && <a className="ml-2 underline" href={answer.citation.canonicalUrl}>{answer.citation.title}</a>}</details>} />}
      {(revealed || flagOpen) && <PublicReviewFeedback apiRef={feedback} key={item.deliveryId} deliveryId={item.deliveryId} allowRatings={revealed} open={flagOpen} onOpenChange={setFlagOpen}/> }
    </article>}
    {(profileGate||demandGate) && <CohortPrompt mode={profileGate?'experience':'demand'} demandTopics={snapshot.demandTopics} experienceDisabled={profileSaving} onExperience={experience=>void saveProfile({experience})} onDemand={demand=>void saveProfile({demand})} onDismissDemand={()=>void saveProfile({demand:{topics:[],dismissed:true}})}/>}
    {item && !profileGate && !demandGate && (card ? !revealed ? <ReviewActionBar onClick={revealCard} disabled={blocked}>Show answer <span className="text-xs">· Space</span></ReviewActionBar> : finished.current===item.deliveryId && !loading && !saving ? <ReviewActionBar onClick={()=>void advance()} disabled={loading}>{loading?'Preparing next item…':'Continue'}</ReviewActionBar> : <ConfidenceButtons mode="footer" onSelect={level=>void persistAnswer(level)} status={blocked?'saving':'idle'}/> : answer ? <ReviewActionBar onClick={()=>void advance()} disabled={blocked}>{loading?'Preparing next question…':<>{answer.isCorrect?'Correct':`Incorrect — answer ${item.options.findIndex(option=>option.label===answer.correctDisplayLabel)+1}`} · Continue</>}</ReviewActionBar> : (selected||skip) ? <ConfidenceButtons mode="footer" onSelect={level=>void persistAnswer(level)} status={blocked?'saving':'idle'}/> : null)}
    </div></div>
  </main>;
}
