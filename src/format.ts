export function rankLabel(rank: number, ranks: number[]) { return (ranks.filter(value => value === rank).length > 1 ? '공동 ' : '') + rank + '위'; }
export function positiveInteger(value: string) { return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0; }
export function submissionStatusText(submitted: boolean) { return submitted ? '제출 완료' : '미제출'; }
export const votingMethodInfo = {
  winner: { label: '1개만 선택' },
  full: { label: '전체 순위 설정' },
  custom: { label: 'N개 선택' },
} as const;
