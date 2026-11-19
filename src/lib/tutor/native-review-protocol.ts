/** Visible exam state shared by ordinary review controls; no voice runtime. */
export interface NativeExamState {
  phase: 'sitting' | 'results';
  paperId: string;
  questionNumber: number;
  totalQuestions: number;
  selectedOption: string | null;
  canPrevious: boolean;
  canNext: boolean;
  canSelect: boolean;
  canReport: boolean;
  deadlineAt: string;
  frozen: boolean;
  submitConfirmationOpen: boolean;
  navigationOpen: boolean;
}
