import { Column, Entity, PrimaryColumn, Unique } from 'typeorm';

@Entity()
@Unique(['txHash'])
export class TransactionEntity {
  @PrimaryColumn()
  txHash: string;

  @Column()
  blockNumber: number;

  @Column({ nullable: true })
  from: string;

  @Column({ nullable: true })
  to: string;

  @Column()
  success: boolean;

  @Column()
  amount: string;

  @Column()
  feesAmount: string;

  @Column()
  totalAmount: string;

  @Column({ nullable: true })
  fromPreviousBalance: string;

  @Column({ nullable: true })
  toPreviousBalance: string;

  @Column({ nullable: true })
  fromNextBalance: string;

  @Column({ nullable: true })
  toNextBalance: string;
}
