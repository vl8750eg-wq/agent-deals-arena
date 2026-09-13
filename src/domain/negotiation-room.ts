import { z } from 'zod';

export const Side = {
  A: 'SIDE_A',
  B: 'SIDE_B',
} as const;

export type Side = (typeof Side)[keyof typeof Side];

export const oppositeSide = (side: Side): Side => (side === Side.A ? Side.B : Side.A);

export const DealTermSchema = z.object({
  kind: z.string().min(1),
  value: z.string().min(1),
});

export const OpponentConditionsSchema = z.object({
  // Единственное обязательное поле: человек описывает сделку своими словами.
  // Числовые лимиты опциональны: нужны детерминированному CLI и серверному gate;
  // LLM-агенты (Codex/Claude) понимают текст сами.
  text: z.string().trim().min(1).max(2_000),
  desiredPrice: z.number().finite().nonnegative().optional(),
  walkAwayPrice: z.number().finite().nonnegative().optional(),
});

export type DealTerm = z.infer<typeof DealTermSchema>;
export type OpponentConditions = z.infer<typeof OpponentConditionsSchema>;

// ACCEPT обязан ссылаться на конкретный PROPOSE оппонента (accepts = id сообщения).
// Сервер отвергает ACCEPT без валидной ссылки — защита от «слепых» согласий.
export const StructuredOfferSchema = z.object({
  price: z.number().finite().nonnegative(),
  currency: z.string().trim().length(3),
  terms: z.array(DealTermSchema),
  status: z.enum(['PROPOSE', 'ACCEPT', 'REJECT']),
  accepts: z.string().min(1).optional(),
});

export type StructuredOffer = z.infer<typeof StructuredOfferSchema>;

export const ConductRules = [
  'Be polite and professional.',
  'Do not insult, threaten, harass, or manipulate the other party.',
  'Do not claim to be human or invent facts.',
  'Discuss only the deal conditions and ask when something is unclear.',
  'Back every price with a concrete, honest reason — bargain like a real person, not a price bot.',
] as const;

export type RoomStatus =
  | 'WAITING_FOR_SUBMISSIONS'
  | 'READY_TO_NEGOTIATE'
  | 'IN_NEGOTIATION'
  | 'DEAL_AGREED'
  | 'FAILED';

export interface AgentContext {
  conductRules: readonly string[];
  privateConditions: OpponentConditions;
  publicMessages: readonly string[];
}

export class NegotiationRoom {
  private readonly conditions = new Map<Side, OpponentConditions>();
  private readonly publicMessages: string[] = [];
  private _status: RoomStatus = 'WAITING_FOR_SUBMISSIONS';

  get status(): RoomStatus {
    return this._status;
  }

  submitConditions(side: Side, conditions: OpponentConditions): void {
    if (this._status !== 'WAITING_FOR_SUBMISSIONS') {
      throw new Error('Conditions can only be submitted before negotiation starts.');
    }

    const parsed = OpponentConditionsSchema.parse(conditions);
    this.conditions.set(side, parsed);

    if (this.conditions.has(Side.A) && this.conditions.has(Side.B)) {
      this._status = 'READY_TO_NEGOTIATE';
    }
  }

  canStartNegotiation(): boolean {
    return this._status === 'READY_TO_NEGOTIATE';
  }

  startNegotiation(): void {
    if (!this.canStartNegotiation()) {
      throw new Error('Both opponents must submit conditions before negotiation starts.');
    }

    this._status = 'IN_NEGOTIATION';
  }

  getAgentContext(side: Side): AgentContext {
    const privateConditions = this.conditions.get(side);

    if (!privateConditions) {
      throw new Error('This opponent has not submitted conditions.');
    }

    return {
      conductRules: ConductRules,
      privateConditions: structuredClone(privateConditions),
      publicMessages: [...this.publicMessages],
    };
  }

  addPublicMessage(message: string): void {
    this.publicMessages.push(message);
  }

  getPublicMessages(): readonly string[] {
    return [...this.publicMessages];
  }

  finish(status: 'DEAL_AGREED' | 'FAILED'): void {
    if (this._status !== 'IN_NEGOTIATION') {
      throw new Error('Negotiation must be active before it can finish.');
    }

    this._status = status;
  }
}
