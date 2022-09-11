import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ethers } from 'ethers';
import {
  BlockWithTransactions,
  TransactionResponse,
  TransactionReceipt,
} from '@ethersproject/abstract-provider';
import { TransactionEntity } from 'src/entities/transaction.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { AccountEntity } from 'src/entities/account.entity';
import { Repository } from 'typeorm';
import BigNumber from 'bignumber.js';
import { LastProcessedBlockEntity } from 'src/entities/last-processed-block.entity';
import { BlockRewardEntity } from 'src/entities/block-reward.entity';

@Injectable()
export class EthService implements OnModuleInit, OnModuleDestroy {
  // service
  private _currentProcess: Promise<void>;
  private _isTerminating = false;
  private _provider: ethers.providers.InfuraProvider;
  private _logger = new Logger(EthService.name);

  // bc
  private readonly _blockchain = 'ETH';
  private readonly _ethDecimals = 18;

  // logging
  private _maxBlockNumberAtStart: number;
  private _processesBlockInSession = 0;
  private _startedAt = Date.now();

  constructor(
    @InjectRepository(AccountEntity)
    private readonly _accountRepository: Repository<AccountEntity>,
    @InjectRepository(TransactionEntity)
    private readonly _transactionRepository: Repository<TransactionEntity>,
    @InjectRepository(LastProcessedBlockEntity)
    private readonly _lastProcessedBlockRepository: Repository<LastProcessedBlockEntity>,
    @InjectRepository(BlockRewardEntity)
    private readonly _blockRewardRepository: Repository<BlockRewardEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    const apiKey = process.env['API_KEY'];
    this._provider = new ethers.providers.InfuraProvider('mainnet', apiKey);
    this._maxBlockNumberAtStart = await this._provider.getBlockNumber();

    this.pullBlocks();
  }

  async onModuleDestroy() {
    this._logger.debug('starting terminating...');
    this._isTerminating = true;
    this._logger.debug('waiting for current processing block...');
    await this._currentProcess;
    this._logger.debug('current processing block done');
  }

  async pullBlocks(): Promise<void> {
    let blockNumber = (await this.getLastProcessedBlockNumber()) + 1;

    while (true) {
      const batchSize = 10;
      const promises: Promise<BlockWithTransactions>[] = [];
      for (let i = 0; i < batchSize; i++) {
        promises.push(this._provider.getBlockWithTransactions(blockNumber + i));
      }

      const blocks = await Promise.all(promises);
      for (const block of blocks) {
        if (this._isTerminating) {
          return;
        }
        this._logger.log(
          `processing block ${blockNumber}, txCount: ${
            block.transactions.length
          } , created on ${new Date(block.timestamp * 1000)}`,
        );

        this._currentProcess = (async () => {
          await this.processBlock(block);
          await this.setLastProcessedBlockNumber(blockNumber);
        })();
        await this._currentProcess;
        blockNumber++;
        this.logProcessingInfo(blockNumber);
      }
    }
  }

  logProcessingInfo(blockNumber: number) {
    this._processesBlockInSession++;
    const durationMinutes = (Date.now() - this._startedAt) / 1000 / 60;
    const avgBlockPerMinute = this._processesBlockInSession / durationMinutes;
    const blocksLeft = this._maxBlockNumberAtStart - blockNumber;
    const hoursLeftToMaxBlock = blocksLeft / avgBlockPerMinute / 60;
    this._logger.log(
      `avg tempo: ${avgBlockPerMinute.toFixed(
        0,
      )} blocks per minute, hours left ${hoursLeftToMaxBlock}, blocksLeft ${blocksLeft} `,
    );
  }

  async processBlock(block: BlockWithTransactions): Promise<void> {
    const totalTx = block.transactions.length;
    let processedTx = 0;
    let feesSum = new BigNumber('0');
    for (const transaction of block.transactions) {
      this._logger.log(
        `processing tx ${
          transaction.hash
        }, ${++processedTx} of ${totalTx},  from block ${
          transaction.blockNumber
        } created on ${new Date(block.timestamp * 1000)}`,
      );
      const tx = await this.processTx(transaction);
      if (!tx) continue;
      feesSum = feesSum.plus(tx.feesAmount);
    }
    await this.processBlockReward(block, feesSum);
  }

  async processBlockReward(block: BlockWithTransactions, feesSum: BigNumber) {
    const blockRewardAmount = this.calcBlockReward(block, feesSum);
    const miner = block.miner.toLowerCase();

    const blockRewardData: BlockRewardEntity = {
      blockNumber: block.number,
      account: miner,
      amount: blockRewardAmount.toString(),
    };

    await this._blockRewardRepository.insert(blockRewardData);
    const account = await this.getOrCreateAccount(miner);
    await this.updateAccountStats({
      ...account,
      totalMinedAmount: new BigNumber(account.totalMinedAmount)
        .plus(blockRewardAmount)
        .toString(),
      totalMinedBlocks: account.totalMinedBlocks + 1,
      balance: new BigNumber(account.balance)
        .plus(blockRewardAmount)
        .toString(),
    });
  }

  async processTx(
    transaction: TransactionResponse,
  ): Promise<TransactionEntity> {
    transaction.hash = transaction.hash.toLowerCase();
    const exists = await this.checkTxExists(transaction.hash);
    if (exists) return;

    const txBase: Partial<TransactionEntity> = {
      txHash: transaction.hash,
      blockNumber: transaction.blockNumber,
      from: transaction.from,
      to: transaction.to,
      amount: transaction.value.toString(),
    };

    const accounts: { from?: AccountEntity; to?: AccountEntity } = {};
    if (txBase.from) {
      txBase.from = txBase.from.toLowerCase();
      accounts.from = await this.getOrCreateAccount(txBase.from);
    }
    if (txBase.to) {
      txBase.to = txBase.to.toLowerCase();
      accounts.to = await this.getOrCreateAccount(txBase.to);
    }

    try {
      const txReceipt = await transaction.wait();

      txBase.success = true;
      txBase.feesAmount = this.calcFeesAmount(txReceipt).toFixed();
      txBase.totalAmount = this.calcFeesAmount(txReceipt)
        .plus(transaction.value.toString())
        .toFixed();
    } catch (e) {
      if (e.message.includes('transaction failed')) {
        txBase.success = false;
        txBase.feesAmount = this.calcFeesAmount(e.receipt).toFixed();
        txBase.totalAmount = this.calcFeesAmount(e.receipt)
          .plus(transaction.value.toString())
          .toFixed();
      } else {
        throw e;
      }
    }

    txBase.fromPreviousBalance = accounts.from?.balance;
    txBase.toPreviousBalance = accounts.to?.balance;
    txBase.fromNextBalance = txBase.fromPreviousBalance
      ? new BigNumber(txBase.fromPreviousBalance)
          .minus(txBase.amount)
          .minus(txBase.feesAmount)
          .toFixed()
      : null;

    txBase.toNextBalance = txBase.toPreviousBalance
      ? new BigNumber(txBase.toPreviousBalance).plus(txBase.amount).toFixed()
      : null;

    await this.saveTx(txBase as TransactionEntity);
    if (accounts.to) {
      await this.updateAccountStats({
        address: accounts.to.address,
        balance: txBase.toNextBalance,
        totalTxCount: accounts.to.totalTxCount + 1,
        incomingTxCount: accounts.to.incomingTxCount + 1,
        outgoingTxCount: accounts.to.outgoingTxCount,
        totalFeesPaid: accounts.to.totalFeesPaid,
        totalReceived: new BigNumber(accounts.to.totalReceived)
          .plus(txBase.amount)
          .toFixed(),
        totalSent: accounts.to.totalSent,
        totalMinedAmount: accounts.to.totalMinedAmount,
        totalMinedBlocks: accounts.to.totalMinedBlocks,
      });
    }
    if (accounts.from) {
      await this.updateAccountStats({
        address: accounts.from.address,
        balance: txBase.fromNextBalance,
        totalTxCount: accounts.from.totalTxCount + 1,
        incomingTxCount: accounts.from.incomingTxCount,
        outgoingTxCount: accounts.from.outgoingTxCount + 1,
        totalFeesPaid: new BigNumber(accounts.from.totalFeesPaid)
          .plus(txBase.feesAmount)
          .toFixed(),
        totalReceived: accounts.from.totalReceived,
        totalSent: new BigNumber(accounts.from.totalSent)
          .plus(txBase.amount)
          .toFixed(),
        totalMinedAmount: accounts.from.totalMinedAmount,
        totalMinedBlocks: accounts.from.totalMinedBlocks,
      });
    }

    return txBase as TransactionEntity;
  }

  calcFeesAmount(txReceipt: TransactionReceipt): BigNumber {
    return new BigNumber(
      txReceipt.gasUsed.mul(txReceipt.effectiveGasPrice).toString(),
    );
  }

  //   calcBurntAmount(
  //     tx: TransactionResponse,
  //     txReceipt: TransactionReceipt,
  //   ): BigNumber {
  //     // burnt = fees - (gasUsed * maxPriorityFeePerGas)
  //     // eip1559
  //     if (tx.type === 2) {
  //       return this.calcFeesAmount(txReceipt).minus(
  //         new BigNumber(txReceipt.gasUsed.toString()).multipliedBy(
  //           tx.maxPriorityFeePerGas.toString(),
  //         ),
  //       );
  //     }
  //     return new BigNumber(0);
  //   }

  calcBlockReward(
    block: BlockWithTransactions,
    feesAmount: BigNumber,
  ): BigNumber {
    let baseBlockReward = new BigNumber('0');
    if (block.number <= 4369999) {
      baseBlockReward = new BigNumber('5');
    } else if (block.number >= 4370000 && block.number <= 7279999) {
      baseBlockReward = new BigNumber('3');
    } else {
      baseBlockReward = new BigNumber('2');
    }
    baseBlockReward = baseBlockReward.shiftedBy(this._ethDecimals);

    // blockReward = baseReward + fees - burnt
    // burnt = gasUsed * baseFeePerGas
    const burnt = block.baseFeePerGas
      ? new BigNumber(block.gasUsed.mul(block.baseFeePerGas).toString())
      : new BigNumber('0');
    const blockReward = baseBlockReward.plus(feesAmount).minus(burnt);
    return blockReward;
  }

  async saveTx(tx: TransactionEntity): Promise<void> {
    // this._logger.debug(`saveTx: ${JSON.stringify(tx)}`);
    await this._transactionRepository.insert(tx);
  }

  async getOrCreateAccount(address: string): Promise<AccountEntity> {
    const account = await this._accountRepository.findOne({
      where: { address },
    });
    if (account) {
      return account;
    } else {
      const accountData: AccountEntity = {
        address,
        balance: '0',
        totalTxCount: 0,
        incomingTxCount: 0,
        outgoingTxCount: 0,
        totalFeesPaid: '0',
        totalReceived: '0',
        totalSent: '0',
        totalMinedAmount: '0',
        totalMinedBlocks: 0,
      };
      await this._accountRepository.insert(accountData);
      return accountData;
    }
  }

  async updateAccountStats(account: AccountEntity): Promise<void> {
    // this._logger.debug(`updateAccountStats: ${JSON.stringify(account)}`);
    await this._accountRepository.update(
      { address: account.address },
      { ...account },
    );
  }
  async checkTxExists(txHash: string): Promise<boolean> {
    const txExist = await this._transactionRepository.findOne({
      where: { txHash },
    });
    return !!txExist;
  }

  async getLastProcessedBlockNumber(): Promise<number> {
    const exist = await this._lastProcessedBlockRepository.findOne({
      where: { blockchain: this._blockchain },
    });
    if (!exist) {
      await this._lastProcessedBlockRepository.insert({
        blockchain: this._blockchain,
        blockNumber: 0,
      });
      return 0;
    } else {
      return exist.blockNumber;
    }
  }

  async setLastProcessedBlockNumber(blockNumber): Promise<void> {
    await this._lastProcessedBlockRepository.update(
      { blockchain: this._blockchain },
      { blockNumber },
    );
  }
}
