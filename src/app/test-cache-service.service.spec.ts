import { TestBed } from '@angular/core/testing';

import { TestCacheServiceService } from './test-cache.service';

describe('TestCacheServiceService', () => {
  let service: TestCacheServiceService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(TestCacheServiceService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
