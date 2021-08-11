import {DynamoDB} from "aws-sdk";
import {DocumentClient} from "aws-sdk/lib/dynamodb/document_client";
import * as crypto from "crypto";
import GetItemInput = DocumentClient.GetItemInput;
import UpdateItemInput = DocumentClient.UpdateItemInput;
import QueryInput = DocumentClient.QueryInput;

type SimpleDynamoType = 'string' | 'string set' | 'number' | 'number set' | 'binary' | 'boolean' | 'null' | 'list' | 'map';

type KeyComparisonBuilder<T> = {
  eq(value: T): void;
  lt(value: T): void;
  lte(value: T): void;
  gt(value: T): void;
  gte(value: T): void;
  between(a: T, b: T): void;
} & (T extends string ? {beginsWith(value: string): void} : {})

type ComparisonBuilder<T> = {[K in keyof T]: Operation<T, T[K]>} & {
  exists(path: string): CompareWrapperOperator<T>;
  notExists(path: string): CompareWrapperOperator<T>;
  isType(path: string, type: SimpleDynamoType): CompareWrapperOperator<T>;
  beginsWith(path: string, beginsWith: string): CompareWrapperOperator<T>;
  contains(path: string, operand: string): CompareWrapperOperator<T>;
  not(comparison: CompareWrapperOperator<T>): CompareWrapperOperator<T>;
}

type CompareWrapperOperator<T> = {
  and(comparison: CompareWrapperOperator<T>): CompareWrapperOperator<T>
  or(comparison: CompareWrapperOperator<T>): CompareWrapperOperator<T>
}

type Operation<T, V>  = {
  eq(value: V): CompareWrapperOperator<T>;
  neq(value: V): CompareWrapperOperator<T>;
  lt(value: V): CompareWrapperOperator<T>;
  lte(value: V): CompareWrapperOperator<T>;
  gt(value: V): CompareWrapperOperator<T>;
  gte(value: V): CompareWrapperOperator<T>;
  between(a: V, b: V): CompareWrapperOperator<T>;
  in(a: V, b: V[]): CompareWrapperOperator<T>;
}

type DynamoType = 'string' | 'number' | 'boolean' | 'null' | DynamoEntryDefinition;
type DynamoEntryDefinition = {[key: string]: DynamoType}

type TypeFor<T extends DynamoType> = T extends 'string' ? string :
  T extends 'number' ? number :
    T extends 'boolean' ? boolean :
      T extends 'null' ? null :
        T extends DynamoEntryDefinition ? DynamoEntry<T> : never;

type DynamoEntry<T extends DynamoEntryDefinition>  = {
  [K in keyof T]: TypeFor<T[K]>
}

class KeyOperation<T> {
  public wrapper = new Wrapper();
  constructor(private readonly key: string) {}
  
  private add(expression: (key: string) => string): (value: T) => void {
    return value => {
      const mappedKey = nameFor(this.key);
      return this.wrapper.add({[`#${mappedKey}`]: this.key},{[`:${mappedKey}`]: value}, expression(mappedKey)) as any
    }
  }
  
  eq = this.add(key => `#${key} = :${key}`)
  neq = this.add(key => `#${key} <> :${key}`)
  lt = this.add(key => `#${key} < :${key}`)
  lte = this.add(key => `#${key} <= :${key}`)
  gt = this.add(key => `#${key} > :${key}`)
  gte = this.add(key => `#${key} >= :${key}`)
}

class OperationType {
  constructor(private readonly wrapper: Wrapper, private readonly key: string) {
  }
  operation(): Operation<any, any> {
    return this as unknown as Operation<any, any>
  }
  
  private add(expression: (key: string) => string): (value: TypeFor<DynamoType>) => CompareWrapperOperator<any> {
    return value => {
      const mappedKey = nameFor(this.key);
      return this.wrapper.add({[`#${mappedKey}`]: this.key},{[`:${mappedKey}`]: value}, expression(mappedKey)) as any
    }
  }
  
  eq = this.add(key => `#${key} = :${key}`)
  neq = this.add(key => `#${key} <> :${key}`)
  lt = this.add(key => `#${key} < :${key}`)
  lte = this.add(key => `#${key} <= :${key}`)
  gt = this.add(key => `#${key} > :${key}`)
  gte = this.add(key => `#${key} >= :${key}`)
  
  between(a: TypeFor<DynamoType>, b: TypeFor<DynamoType>): CompareWrapperOperator<any> {
    const mappedKey = nameFor(this.key);
    const aKey = `:${mappedKey}1`
    const bKey = `:${mappedKey}2`
    return this.wrapper.add({[`#${mappedKey}`]: this.key},{[aKey]: a, [bKey]: b}, `#${mappedKey} BETWEEN ${aKey} AND ${bKey}`) as any;
  }
  in(list: TypeFor<DynamoType>[]): CompareWrapperOperator<any> {
    const mappedKey = nameFor(this.key);
    const valueMappings = list.reduce((agg, it, index) => ({...agg, [`:${mappedKey}${index}`]: it}), {} as any);
    return this.wrapper.add({[`#${mappedKey}`]: this.key}, valueMappings, `#${mappedKey} IN (${Object.keys(valueMappings).map(it => `:${it}`).join(',')})`) as any
  }
}

class ComparisonBuilderType<D extends DynamoEntryDefinition, T extends DynamoEntry<D>> {
  public wrapper = new Wrapper();
  constructor(definition: D) {
    Object.keys(definition).forEach(key => {
      (this as any)[key] = new OperationType(this.wrapper, key).operation();
    })
  }
  
  exists(path: string): Wrapper {
    return this.wrapper.add({}, {}, `attribute_exists(${path})`)
  }
  notExists(path: string): Wrapper {
    return this.wrapper.add({}, {}, `attribute_not_exists(${path})`)
  }
  private typeFor(type: SimpleDynamoType): string {
    switch (type) {
      case 'string': return 'S';
      case 'string set': return 'S';
      case 'number': return 'S';
      case 'number set': return 'S';
      case 'binary': return 'S';
      case 'boolean': return 'S';
      case 'null': return 'S';
      case 'list': return 'S';
      case 'map': return 'S';
    }
  }
  
  isType(path: string, type: SimpleDynamoType): Wrapper {
    const key = Math.floor(Math.random() * 10000000);
    return this.wrapper.add({}, {[key]: this.typeFor(type)}, `attribute_type(${path}, :${key})`)
  }
  
  beginsWith(path: string, beginsWith: string): Wrapper {
    const key = Math.floor(Math.random() * 10000000);
    return this.wrapper.add({}, {[key]: beginsWith}, `begins_with(${path}, :${key})`)
  }
  
  contains(path: string, operand: string): Wrapper {
    const key = Math.floor(Math.random() * 10000000);
    return this.wrapper.add({}, {[key]: operand}, `operand(${path}, :${key})`)
  }
  
  not(comparison: Wrapper): Wrapper {
    this.wrapper.names = comparison.names;
    this.wrapper.valueMappings = comparison.valueMappings;
    this.wrapper.expression = `NOT (${comparison.expression})`
    return this.wrapper;
  }
  
  builder(): ComparisonBuilder<T> {
    return this as unknown as ComparisonBuilder<T>;
  }
}

class Wrapper {
  
  constructor(public names: Record<string, string> = {}, public valueMappings: Record<string, unknown> = {}, public expression: string = '') {}
  
  add(names: Record<string, string> = {}, valueMappings: Record<string, unknown> = {}, expression: string = ''): Wrapper {
    this.names = {...this.names, ...names};
    this.valueMappings = {...this.valueMappings, ...valueMappings};
    this.expression = expression;
    return this;
  }
  
  and(comparison: Wrapper): Wrapper {
    this.add(comparison.names, comparison.valueMappings, `(${this.expression}) AND (${comparison.expression})`)
    return this;
  }
  
  or(comparison: Wrapper): Wrapper {
    this.add(comparison.names, comparison.valueMappings, `(${this.expression}) OR (${comparison.expression})`)
    return this;
  }
}

export class DynamoTable<D extends DynamoEntryDefinition, T extends DynamoEntry<D>, H extends keyof T, R extends keyof T | null = null> {
  private constructor(
    protected readonly table: string,
    protected readonly dynamo: DynamoDB.DocumentClient,
    private readonly definition: D,
    private readonly hashKey: H,
    private readonly rangeKey: R | undefined,
  ) {}
  
  async get(key: {[K in (R extends string ? H | R :  H)]: T[K]}, extras: Omit<GetItemInput, 'TableName' | 'Key'> = {}): Promise<T | undefined> {
    const result = await this.dynamo.get({TableName: this.table, Key: key, ProjectionExpression: Object.keys(this.definition).join(','), ...extras}).promise();
    return result.Item as T | undefined;
  }
  
  async put(item: T): Promise<T> {
    await this.dynamo.put({TableName: this.table, Item: item}).promise();
    return item;
  }
  
  async delete(key: {[K in (R extends string ? H | R :  H)]: T[K]}): Promise<void> {
    await this.dynamo.delete({TableName: this.table, Key: key}).promise();
  }
  
  async update(key: {[K in (R extends string ? H | R :  H)]: T[K]}, updates: Partial<Omit<T, R extends string ? H | R :  H>>, increment?: keyof Omit<T, R extends string ? H | R :  H>, start?: unknown, extras?: Partial<UpdateItemInput>): Promise<T | undefined> {
    const result = await this.dynamo.update({
      TableName: this.table,
      Key: key,
      ...this.updateExpression(updates, increment, start),
      ...(extras ?? {})
    }).promise();
    return result.Attributes as T | undefined;
  }
  
  async scan(next?: string): Promise<{member: T[], next?: string}> {
    const result = await this.dynamo.scan({
      TableName: this.table,
      ProjectionExpression: Object.keys(this.definition).join(','),
      ...(next ? {ExclusiveStartKey: JSON.parse(Buffer.from(next, 'base64').toString('ascii'))} : {})
    }).promise();
    return {
      member: (result.Items ?? []) as T[],
      next: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey!)).toString('base64') : undefined
    }
  }
  
  async query<P extends (keyof T)[] | null = null>
  (queryParameters:
     { [K in H]: T[K] } &
     (R extends string ? {[K in R]?: (sortKey: KeyComparisonBuilder<T[R]>) => any } : {}) &
     {filter?: (compare: () => ComparisonBuilder<Omit<T, R extends string ? H | R : H>>) => CompareWrapperOperator<Omit<T, R extends string ? H | R : H>>} &
     {projection?: P, next?: string} & { dynamo?: Omit<QueryInput, 'TableName' | 'IndexName' | 'KeyConditionExpression' | 'ProjectionExpression' | 'FilterExpression' | 'ExclusiveStartKey'> }): Promise<{next?: string, member: (P extends (keyof T)[] ? {[K in (R extends string ? P[number] | H | R : P[number] | H)]: T[K]}[] : {[K in keyof T]: T[K]}[])}>{
    const keyPart = this.keyPart(queryParameters);
    const filterPart = this.filterPart(queryParameters);
    const queryInput: QueryInput = {
      TableName: this.table,
      ...keyPart,
      ...(filterPart.FilterExpression ? { FilterExpression: filterPart.FilterExpression } : {}),
      ExpressionAttributeNames: {...keyPart.ExpressionAttributeNames, ...filterPart.ExpressionAttributeNames},
      ExpressionAttributeValues: {...keyPart.ExpressionAttributeValues, ...filterPart.ExpressionAttributeValues},
      ...(queryParameters.projection ? { ProjectionExpression: queryParameters.projection.join(',') } : {ProjectionExpression: Object.keys(this.definition).join(',')}),
      ...(queryParameters.dynamo ?? {}),
      ...(queryParameters.next ? {ExclusiveStartKey: JSON.parse(Buffer.from(queryParameters.next, 'base64').toString('ascii'))} : {})
    }
    const result = await this.dynamo.query(queryInput).promise();
    return {
      member: (result.Items ?? []) as T[],
      next: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey!)).toString('base64') : undefined
    }
  }
  
  private keyPart(query: { [K in H]: T[K] } & (R extends string ? {[K in R]?: (sortKey: KeyComparisonBuilder<T[R]>) => any } : {})): Pick<QueryInput, 'KeyConditionExpression' | 'ExpressionAttributeNames' | 'ExpressionAttributeValues'>{
    const hashValue = query[this.hashKey];
    const expression = '#hash = :hash';
    const names = { ['#hash']: this.hashKey as string };
    const values = { [':hash']: hashValue };
    if(this.rangeKey && (query as any)[this.rangeKey]){
      const keyOperation = new KeyOperation(this.rangeKey as string);
      (query as any)[this.rangeKey](keyOperation);
      return {
        KeyConditionExpression: `${expression} AND ${keyOperation.wrapper.expression}`,
        ExpressionAttributeNames: {...names, ...keyOperation.wrapper.names},
        ExpressionAttributeValues: {...values, ...keyOperation.wrapper.valueMappings}
      }
    }
    return {
      KeyConditionExpression: expression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values
    }
  }
  
  private filterPart(query: {filter?: (compare: () => ComparisonBuilder<Omit<T, R extends string ? H | R : H>>) => CompareWrapperOperator<Omit<T, R extends string ? H | R : H>>}): Pick<QueryInput, 'FilterExpression' | 'ExpressionAttributeNames' | 'ExpressionAttributeValues'> {
    if(query.filter) {
      const updatedDefinition = Object.keys(this.definition).filter(it => it !== this.hashKey && it !== this.rangeKey).reduce((acc, it) => ({...acc, [it]: this.definition[it]}), {});
      const builder = () => new ComparisonBuilderType(updatedDefinition).builder();
      const parent = query.filter(builder as any) as unknown as Wrapper;
      return {
        FilterExpression: parent.expression,
        ExpressionAttributeNames: parent.names,
        ExpressionAttributeValues: parent.valueMappings
      }
    } return {ExpressionAttributeValues: {}, ExpressionAttributeNames: {}}
  }
  
  private updateExpression(properties: Partial<Omit<T, R extends string ? H | R :  H>>, increment?: keyof Omit<T, R extends string ? H | R :  H>, start?: unknown): {UpdateExpression: string, ExpressionAttributeNames: Record<string, string>, ExpressionAttributeValues: Record<string, any> } {
    const props = properties as any;
    const validKeys = Object.keys(properties).filter(it => !!props[it]);
    const removes = Object.keys(properties).filter(it => !props[it]);
    const updateExpression = `SET ${validKeys.map(key => `#${nameFor(key)} = ${increment === key ? `${(start !== undefined) ? `if_not_exists(${key}, :start)` : `#${nameFor(key)}`} + ` : ''}:${nameFor(key)}`).join(', ')}` +
      (removes.length > 0 ? ` REMOVE ${removes.map(key => `#${nameFor(key)}`).join(', ')}` : '');
    const names = [...validKeys, ...removes].reduce((names, key) => ({...names, [`#${nameFor(key)}`]: key}), {});
    const values = validKeys.reduce((values, key) => ({...values, [`:${nameFor(key)}`]: props[key]}), {});
    return {
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: (start !== undefined) ? {...values, [':start']: start} : values
    }
  }
  
  static build<D extends DynamoEntryDefinition, H extends keyof D, R extends keyof D | null = null>(table: string, dynamo: DynamoDB.DocumentClient, definition: {definition: D, hashKey: H, rangeKey?: R}): DynamoTable<D, DynamoEntry<D>, H, R> {
    return new DynamoTable<D, DynamoEntry<D>, H, R>(table, dynamo, definition.definition, definition.hashKey, definition.rangeKey);
  }
}

function nameFor(name: string): string {
  return crypto.createHash('md5').update(name).digest('hex');
}
