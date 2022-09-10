import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity()
export class BlockRewardEntity {
  @PrimaryColumn()
  blockNumber: number;

  @Column()
  account: string;

  @Column()
  amount: string;
}
