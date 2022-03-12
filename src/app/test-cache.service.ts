import { Injectable } from '@angular/core';
import { CacheServiceObsBase } from 'src/CodeAngular';

@Injectable({
  providedIn: 'root'
})
export class TestCacheService extends CacheServiceObsBase<string, string> {

  constructor() {
    super();
  }

  testCreateData() {

  }
}
