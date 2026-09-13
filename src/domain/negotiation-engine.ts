import {
  NegotiationRoom,
  type AgentContext,
  type Side,
  type StructuredOffer,
} from './negotiation-room';

export interface AgentTurn {
  offer: StructuredOffer;
  message: string;
}

export type AgentRunner = (context: AgentContext) => AgentTurn;

export type AgentRunners = Record<Side, AgentRunner>;

export interface NegotiationResult {
  status: 'DEAL_AGREED' | 'REJECTED' | 'MAX_ROUNDS_REACHED';
  rounds: number;
  lastTurn?: AgentTurn;
}

export class NegotiationEngine {
  constructor(
    private readonly room: NegotiationRoom,
    private readonly runners: AgentRunners,
    private readonly maxRounds = 6,
  ) {}

  run(): NegotiationResult {
    this.room.startNegotiation();

    let lastTurn: AgentTurn | undefined;
    const sides: Side[] = ['SIDE_A', 'SIDE_B'];

    for (let index = 0; index < this.maxRounds; index += 1) {
      const side = sides[index % sides.length];
      const turn = this.runners[side](this.room.getAgentContext(side));
      lastTurn = turn;
      this.room.addPublicMessage(`${side}: ${turn.message}`);

      if (turn.offer.status === 'ACCEPT') {
        this.room.finish('DEAL_AGREED');
        return { status: 'DEAL_AGREED', rounds: index + 1, lastTurn };
      }

      if (turn.offer.status === 'REJECT') {
        this.room.finish('FAILED');
        return { status: 'REJECTED', rounds: index + 1, lastTurn };
      }
    }

    this.room.finish('FAILED');
    return { status: 'MAX_ROUNDS_REACHED', rounds: this.maxRounds, lastTurn };
  }
}
