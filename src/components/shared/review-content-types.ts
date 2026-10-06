import type { ReactNode, RefObject } from 'react';
import type { ReviewPaneKind } from './review-pane-layout';

export type ReviewContentLayout = 'flat' | 'prompt' | 'supplementary';

export interface ReviewPaneCellClasses {
  top?: string;
  media?: string;
  bottom?: string;
}

export interface ReviewCardContentProps {
  compactPrompt?: boolean;
  layout: ReviewContentLayout;
  paneKind?: ReviewPaneKind;
  className?: string;
  cellClassName?: ReviewPaneCellClasses;
  stem: ReactNode;
  reveal?: ReactNode;
  answer?: ReactNode;
  media?: ReactNode;
  links?: ReactNode;
  answerRef?: RefObject<HTMLDivElement | null>;
}

export interface ReviewQuestionContentProps {
  layout: ReviewContentLayout;
  paneKind?: ReviewPaneKind;
  className?: string;
  cellClassName?: ReviewPaneCellClasses;
  stem: ReactNode;
  options: ReactNode;
  result?: ReactNode;
  media?: ReactNode;
  tail?: ReactNode;
  answerRef?: RefObject<HTMLDivElement | null>;
}
