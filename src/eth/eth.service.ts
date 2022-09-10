import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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

@Injectable()
export class EthService implements OnModuleInit {
  private _provider: ethers.providers.InfuraProvider;
  private _logger = new Logger(EthService.name);
  private readonly _blockchain = 'ETH';

  //logging
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
  ) {}

  async onModuleInit(): Promise<void> {
    const apiKey = process.env['API_KEY'];
    this._provider = new ethers.providers.InfuraProvider('mainnet', apiKey);
    this._maxBlockNumberAtStart = await this._provider.getBlockNumber();

    this.pullBlocks();
  }

  async pullBlocks(): Promise<void> {
    let blockNumber = await this.getLastProcessedBlockNumber();

    while (true) {
      const batchSize = 5;
      const promises: Promise<BlockWithTransactions>[] = [];
      for (let i = 0; i < batchSize; i++) {
        promises.push(this._provider.getBlockWithTransactions(blockNumber + i));
      }

      const blocks = await Promise.all(promises);
      for (const block of blocks) {
        this._logger.log(
          `processing block ${blockNumber}, txCount: ${
            block.transactions.length
          } , created on ${new Date(block.timestamp * 1000)}`,
        );

        //   const _processBlockStartAt = Date.now();
        await this.processBlock(block);
        //   console.log('processBlock ms', Date.now() - _processBlockStartAt);
        await this.setLastProcessedBlockNumber(blockNumber);
        blockNumber++;
        this.logProcessingInfo(blockNumber);
      }
    }
  }

  logProcessingInfo(blockNumber: number) {
    this._processesBlockInSession++;
    const _durationMinutes = (Date.now() - this._startedAt) / 1000 / 60;
    const _avgBlockPerMinute = this._processesBlockInSession / _durationMinutes;
    const _blocksLeft = this._maxBlockNumberAtStart - blockNumber;
    const _hoursLeftToMaxBlock = _blocksLeft / _avgBlockPerMinute / 60;
    this._logger.log(
      `avg tempo: ${_avgBlockPerMinute.toFixed(
        0,
      )} blocks per minute, hours left ${_hoursLeftToMaxBlock}, blocksLeft ${_blocksLeft} `,
    );
  }

  async processBlock(block: BlockWithTransactions): Promise<void> {
    const totalTx = block.transactions.length;
    let processedTx = 0;
    for (const transaction of block.transactions) {
      this._logger.log(
        `processing tx ${
          transaction.hash
        }, ${processedTx++} of ${totalTx},  from block ${
          transaction.blockNumber
        } created on ${new Date(block.timestamp * 1000)}`,
      );
      await this.processTx(transaction);
    }
  }

  async processTx(transaction: TransactionResponse): Promise<void> {
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
      txBase.feesAmount = this.calcFeesAmount(txReceipt).toString();
      txBase.totalAmount = this.calcFeesAmount(txReceipt)
        .plus(transaction.value.toString())
        .toString();
    } catch (e) {
      if (e.message.includes('transaction failed')) {
        txBase.success = false;
        txBase.feesAmount = this.calcFeesAmount(e.receipt).toString();
        txBase.totalAmount = this.calcFeesAmount(e.receipt)
          .plus(transaction.value.toString())
          .toString();
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
          .toString()
      : null;

    txBase.toNextBalance = txBase.toPreviousBalance
      ? new BigNumber(txBase.toPreviousBalance).plus(txBase.amount).toString()
      : null;

    //   console.log(txBase)
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
          .toString(),
        totalSent: accounts.to.totalSent,
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
          .toString(),
        totalReceived: accounts.from.totalReceived,
        totalSent: new BigNumber(accounts.from.totalSent)
          .plus(txBase.amount)
          .toString(),
      });
    }
  }

  calcFeesAmount(txReceipt: TransactionReceipt): BigNumber {
    return new BigNumber(
      txReceipt.effectiveGasPrice.add(txReceipt.cumulativeGasUsed).toString(),
    );
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
        blockNumber: 1,
      });
      return 1;
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
