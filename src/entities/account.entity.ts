import { Column, Entity, PrimaryColumn, Unique } from 'typeorm';

@Entity()
@Unique(['address'])
export class AccountEntity {
  @PrimaryColumn()
  address: string;

  @Column()
  balance: string;

  @Column()
  totalTxCount: number;

  @Column()
  incomingTxCount: number;

  @Column()
  outgoingTxCount: number;

  @Column()
  totalFeesPaid: string;

  @Column()
  totalReceived: string;

  @Column()
  totalSent: string;

  @Column()
  totalMinedAmount: string;

  @Column()
  totalMinedBlocks: number;
}
