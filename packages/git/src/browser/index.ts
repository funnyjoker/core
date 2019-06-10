import { Provider, Injectable } from '@ali/common-di';
import { SlotMap } from '@ali/ide-core-browser';
import { BrowserModule, SlotLocation } from '@ali/ide-core-browser';
import { GitContribution } from './git-contribution';

@Injectable()
export class GitModule extends BrowserModule {
  providers: Provider[] = [
    GitContribution,
  ];
  slotMap: SlotMap = new Map([
  ]);
}
