export function rankLabel(rank: number, ranks: number[]) { return (ranks.filter(value => value === rank).length > 1 ? '공동 ' : '') + rank + '위'; }
export function positiveInteger(value: string) { return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0; }
export const votingMethodInfo = {
  winner: { label: '1개만 선택', description: '가장 마음에 든 와인 한 병에 1표를 주세요.' },
  full: { label: '전체 순위 설정', description: '가장 마음에 든 와인부터 모든 와인의 순위를 정해 주세요.' },
  custom: { label: 'N개 선택', description: '서로 다른 와인을 골라 순위를 정해 주세요.' },
} as const;
