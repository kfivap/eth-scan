import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity()
export class LastProcessedBlockEntity {
  @PrimaryColumn()
  blockchain: string;

  @Column()
  blockNumber: number;
}
