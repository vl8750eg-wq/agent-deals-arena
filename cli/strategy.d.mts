// Types for the plain-JS CLI mirror of src/domain/agent-strategy.ts.
export type ConcessionStrategy = 'firm' | 'cooperative' | 'mirror';

export interface StrategyMessage {
  id: string;
  side: 'SIDE_A' | 'SIDE_B';
  offer: { price: number; currency: string; terms: unknown[]; status: 'PROPOSE' | 'ACCEPT' | 'REJECT'; accepts?: string };
  message: string;
}

export interface StrategyInput {
  role: 'SIDE_A' | 'SIDE_B';
  desiredPrice: number;
  walkAwayPrice: number;
  strategy: ConcessionStrategy;
  messages: StrategyMessage[];
  myTurnsTaken: number;
}

export interface StrategyOutput {
  offer: StrategyMessage['offer'];
  message: string;
}

export function nextOffer(input: StrategyInput): StrategyOutput;

export interface InferredLimits {
  desiredPrice: number;
  walkAwayPrice: number;
  numbers: number[];
}

export function inferLimits(text: string, role: 'SIDE_A' | 'SIDE_B'): InferredLimits | null;
