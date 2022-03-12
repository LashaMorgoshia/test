import { Observable, Subject, map, filter, tap, share, Subscription, shareReplay, ReplaySubject } from "rxjs";

export interface IBaseLoads {
  [key: string]: boolean;
}

export abstract class CacheServiceObsBase<K, T> {
  private _primary_key: string = 'id';

  private oAll: Observable<Map<K, T>>;
  protected refreshSubject: Subject<Map<K, T>> = new Subject<Map<K, T>>();
  private fullSubCount: number = 0;

  private oById: Map<K, Observable<T>> = new Map<K, Observable<T>>();
  protected entityRefreshSubject: Subject<T> = new Subject<T>();
  protected deletesSubject: Subject<T> = new Subject<T>();
  private idSubCount: Map<K, number> = new Map<K, number>();

  private _entities: Map<K, T> = new Map<K, T>();

  private _state: Observable<Map<K, T>>;

  private _loadingSubject: Subject<boolean> = new Subject<boolean>();

  constructor(pk: string = 'id') {
    this._primary_key = pk;
  }

  get primary_key(): string {
    return this._primary_key;
  }

  public loading(): Observable<boolean> {
    return this._loadingSubject.asObservable();
  }

  get loadingSubject(): Observable<boolean> {
    return this.loading();
  }

  private makeState(): void {
    this._state = mergeData([
      this.refreshSubject.asObservable().pipe(
        map(d => {
          const result: Map<K, T> = new Map<K, T>();
          if (!d) {
            return result;
          }
          for (const [k, v] of d.entries()) {
            result.set(k, this.parse(v));
          }
          return result;
        })
      ),
      this.entityRefreshSubject.asObservable().pipe(
        filter(e => !!e),
        map(entity => {
          const newState: Map<K, T> = new Map<K, T>(this._entities.entries());
          newState.set(entity[this._primary_key], this.parse(entity));
          return newState;
        })
      ),
      this.deletesSubject.asObservable().pipe(
        filter(e => !!e),
        map(deleted => {
          const newState: Map<K, T> = new Map<K, T>(this._entities.entries());
          newState.delete(deleted[this._primary_key]);
          return newState;
        })
      ),
      this.updates().pipe(map(update => this.applyUpdates(this._entities, update)))
    ]).pipe(
      tap(entities => {
        this._entities = entities;
        this._loadingSubject.next(false);
      }),
      share()
    );
  }

  private get state(): Observable<Map<K, T>> {
    if (!this._state) {
      this.makeState();
    }
    return this._state;
  }

  protected applyUpdates(initial: Map<K, T>, update: PubsubMsg): Map<K, T> {
    const entities: Map<K, T> = new Map<K, T>(initial.entries());

    switch (update.a) {
      case PubsubAction.Insert:
        if (!entities.has(update.d[this.primary_key])) {
          entities.set(update.d[this.primary_key], this.parse(update.d as T));
        }
        break;

      case PubsubAction.FullUpdate:
        entities.set(update.d[this.primary_key], this.parse(update.d as T));
        break;

      case PubsubAction.Update:
        if (entities.has(update.d[this.primary_key])) {
          const patched: T = this.patch(entities.get(update.d[this.primary_key]), update.d);
          entities.set(update.d[this.primary_key], this.parse(patched));
        }
        break;

      case PubsubAction.Delete:
        entities.delete(update.d[this.primary_key]);
        break;
    }

    return entities;
  }

  protected parse(data: T): T {
    return data;
  }

  protected patch(initial: T, newValues: Partial<T>): T {
    const o: T = { ...initial } as T;
    for (const k in newValues) {
      if (newValues.hasOwnProperty(k)) {
        o[k] = newValues[k];
      }
    }
    return o;
  }

  private makeOAll(): void {
    this.oAll = new Observable<Map<K, T>>(subscriber => {
      this.fullSubCount++;
      const sub: Subscription = this.state.subscribe(subscriber);
      this.refreshAll();
      return () => {
        this.fullSubCount--;
        sub.unsubscribe();
      };
    }).pipe(shareReplay({ bufferSize: 1, refCount: true }));
  }

  public getEntities(): Observable<Map<K, T>> {
    this._loadingSubject.next(true);

    if (!this.oAll) {
      this.makeOAll();
    }

    return this.oAll.pipe(
      tap(() => {
        this._loadingSubject.next(false);
      })
    );
  }

  public getArray(): Observable<T[]> {
    return this.getEntities().pipe(map(dataMap => Array.from(dataMap.values())));
  }

  private makeOForId(id: K): Observable<T> {
    return new Observable<T>(subscriber => {
      this.idSubCount.set(id, 1);

      const sub: Subscription = this.state
        .pipe(map(state => (state.has(id) ? state.get(id) : null)))
        .subscribe(subscriber);

      if (this.fullSubCount <= 0 || !this._entities.has(id)) {
        this.refresh(id);
      } else {
        if (this._entities.has(id)) {
          subscriber.next(this._entities.get(id));
        } else {
          this.refresh(id);
        }
      }

      return () => {
        this.idSubCount.delete(id);
        sub.unsubscribe();
      };
    }).pipe(shareReplay({ bufferSize: 1, refCount: true }));
  }

  public getEntity(id: K): Observable<T> {
    this._loadingSubject.next(true);

    if (!this.oById.has(id)) {
      this.oById.set(id, this.makeOForId(id));
    }

    return this.oById.get(id).pipe(
      tap(() => {
        this._loadingSubject.next(false);
      })
    );
  }

  public refreshAll(): void {
    this._loadingSubject.next(true);

    this.fetchAll().subscribe(fullUpdate => {
      this.refreshSubject.next(fullUpdate);
      this._loadingSubject.next(false);
    });
  }

  private _createUpdateForward(input: Observable<T>): Observable<T> {
    if (!input) {
      return;
    }

    this._loadingSubject.next(true);

    const subj: ReplaySubject<T> = new ReplaySubject<T>(1);
    input
      .pipe(
        tap(
          x => {
            if (x) {
              this.entityRefreshSubject.next(x);
            }
          },
          err => {
            this._loadingSubject.next(false);
          },
          () => {
            this._loadingSubject.next(false);
          }
        )
      )
      .subscribe(subj);
    return subj.asObservable();
  }

  public createEntity(entity: T): Observable<T> {
    return this._createUpdateForward(this._createEntity(entity));
  }

  public updateEntity(entity: T): Observable<T> {
    return this._createUpdateForward(this._updateEntity(entity));
  }

  public deleteEntity(entity: T): Observable<T> {
    this._loadingSubject.next(true);

    const apiResult: Observable<T> = this._deleteEntity(entity);
    const subj: ReplaySubject<T> = new ReplaySubject<T>(1);
    apiResult
      .pipe(
        tap(
          x => {
            if (x) {
              this.deletesSubject.next(x);
            }
          },
          err => {
            this._loadingSubject.next(false);
          },
          () => {
            this._loadingSubject.next(false);
          }
        )
      )
      .subscribe(subj);
    return subj.asObservable();
  }

  public invalidateAll(): void {
    if (this.fullSubCount > 0) {
      this.refreshAll();
      return;
    }

    for (const k of this.idSubCount.keys()) {
      this.refresh(k);
    }
  }

  public refresh(id: K): void {
    this._loadingSubject.next(true);

    this.fetch(id).subscribe(entity => {
      this.entityRefreshSubject.next(entity);
      this._loadingSubject.next(false);
    });
  }

  public invalidate(id: K): void {
    if (this.idSubCount.has(id) || this.fullSubCount > 0) {
      this.refresh(id);
    }
  }

  protected abstract updates(): Observable<PubsubMsg>;

  protected abstract fetch(k: K): Observable<T>;

  protected abstract fetchAll(): Observable<Map<K, T>>;

  protected abstract _createEntity(entity: T): Observable<T>;

  protected abstract _updateEntity(entity: T): Observable<T>;

  protected abstract _deleteEntity(entity: T): Observable<T>;
}
