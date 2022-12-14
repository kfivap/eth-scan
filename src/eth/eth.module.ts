import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountEntity } from 'src/entities/account.entity';
import { BlockRewardEntity } from 'src/entities/block-reward.entity';
import { LastProcessedBlockEntity } from 'src/entities/last-processed-block.entity';
import { TransactionEntity } from 'src/entities/transaction.entity';
import { EthService } from './eth.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AccountEntity,
      TransactionEntity,
      LastProcessedBlockEntity,
      BlockRewardEntity,
    ]),
  ],
  providers: [EthService],
})
export class EthModule {}
