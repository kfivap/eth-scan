import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { AccountEntity } from './entities/account.entity';
import { BlockRewardEntity } from './entities/block-reward.entity';
import { LastProcessedBlockEntity } from './entities/last-processed-block.entity';
import { TransactionEntity } from './entities/transaction.entity';
import { EthModule } from './eth/eth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      password: 'qwerty',
      database: 'eth_accounts',
      entities: [
        TransactionEntity,
        AccountEntity,
        LastProcessedBlockEntity,
        BlockRewardEntity,
      ],
      synchronize: true,
      namingStrategy: new SnakeNamingStrategy(),
      // logging: true,
    }),
    EthModule,
  ],
})
export class AppModule {}
