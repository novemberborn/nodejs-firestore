/*!
 * Copyright 2019 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {google} from '../protos/firestore_v1_proto_api';
import {
  DocumentMask,
  DocumentSnapshot,
  DocumentTransform,
  Precondition,
} from './document';
import {Firestore} from './index';
import {logger} from './logger';
import {FieldPath, validateFieldPath} from './path';
import {DocumentReference, validateDocumentReference} from './reference';
import {Serializer, validateUserInput} from './serializer';
import {Timestamp} from './timestamp';
import {
  Precondition as PublicPrecondition,
  SetOptions,
  UpdateData,
  UpdateMap,
} from './types';
import {DocumentData} from './types';
import {isObject, isPlainObject, requestTag} from './util';
import {
  customObjectMessage,
  invalidArgumentMessage,
  RequiredArgumentOptions,
  validateMaxNumberOfArguments,
  validateMinNumberOfArguments,
  validateOptional,
} from './validate';

import api = google.firestore.v1;
import {GoogleError, Status} from 'google-gax';

/*!
 * Google Cloud Functions terminates idle connections after two minutes. After
 * longer periods of idleness, we issue transactional commits to allow for
 * retries.
 */
const GCF_IDLE_TIMEOUT_MS = 110 * 1000;

/**
 * A WriteResult wraps the write time set by the Firestore servers on sets(),
 * updates(), and creates().
 *
 * @class
 */
export class WriteResult {
  /**
   * @hideconstructor
   *
   * @param _writeTime The time of the corresponding document write.
   */
  constructor(private readonly _writeTime: Timestamp) {}

  /**
   * The write time as set by the Firestore servers.
   *
   * @type {Timestamp}
   * @name WriteResult#writeTime
   * @readonly
   *
   * @example
   * let documentRef = firestore.doc('col/doc');
   *
   * documentRef.set({foo: 'bar'}).then(writeResult => {
   *   console.log(`Document written at: ${writeResult.writeTime.toDate()}`);
   * });
   */
  get writeTime(): Timestamp {
    return this._writeTime;
  }

  /**
   * Returns true if this `WriteResult` is equal to the provided value.
   *
   * @param {*} other The value to compare against.
   * @return true if this `WriteResult` is equal to the provided value.
   */
  isEqual(other: WriteResult): boolean {
    return (
      this === other ||
      (other instanceof WriteResult &&
        this._writeTime.isEqual(other._writeTime))
    );
  }
}

/**
 * A BatchWriteResult wraps the write time and status returned by Firestore
 * when making BatchWriteRequests.
 *
 * @private
 */
export class BatchWriteResult {
  constructor(
    readonly writeTime: Timestamp | null,
    readonly status: GoogleError
  ) {}
}

/**
 * A lazily-evaluated write that allows us to detect the Project ID before
 * serializing the request.
 * @private
 */
type PendingWriteOp = () => api.IWrite;

/**
 * A Firestore WriteBatch that can be used to atomically commit multiple write
 * operations at once.
 *
 * @class
 */
export class WriteBatch {
  private readonly _firestore: Firestore;
  private readonly _serializer: Serializer;

  /**
   * An array of write operations that are executed as part of the commit. The
   * resulting `api.IWrite` will be sent to the backend.
   * @private
   */
  private readonly _ops: Array<PendingWriteOp> = [];

  private _committed = false;

  /**
   * @hideconstructor
   *
   * @param firestore The Firestore Database client.
   */
  constructor(firestore: Firestore) {
    this._firestore = firestore;
    this._serializer = new Serializer(firestore);
  }

  /**
   * Checks if this write batch has any pending operations.
   *
   * @private
   */
  get isEmpty(): boolean {
    return this._ops.length === 0;
  }

  /**
   * Throws an error if this batch has already been committed.
   *
   * @private
   */
  private verifyNotCommitted(): void {
    if (this._committed) {
      throw new Error('Cannot modify a WriteBatch that has been committed.');
    }
  }

  /**
   * Create a document with the provided object values. This will fail the batch
   * if a document exists at its location.
   *
   * @param {DocumentReference} documentRef A reference to the document to be
   * created.
   * @param {T} data The object to serialize as the document.
   * @returns {WriteBatch} This WriteBatch instance. Used for chaining
   * method calls.
   *
   * @example
   * let writeBatch = firestore.batch();
   * let documentRef = firestore.collection('col').doc();
   *
   * writeBatch.create(documentRef, {foo: 'bar'});
   *
   * writeBatch.commit().then(() => {
   *   console.log('Successfully executed batch.');
   * });
   */
  create<T>(documentRef: DocumentReference<T>, data: T): WriteBatch {
    validateDocumentReference('documentRef', documentRef);
    const firestoreData = documentRef._converter.toFirestore(data);
    validateDocumentData('data', firestoreData, /* allowDeletes= */ false);

    this.verifyNotCommitted();

    const transform = DocumentTransform.fromObject(documentRef, firestoreData);
    transform.validate();

    const precondition = new Precondition({exists: false});

    const op: PendingWriteOp = () => {
      const document = DocumentSnapshot.fromObject(documentRef, firestoreData);
      const write = document.toProto();
      if (!transform.isEmpty) {
        write.updateTransforms = transform.toProto(this._serializer);
      }
      write.currentDocument = precondition.toProto();
      return write;
    };

    this._ops.push(op);

    return this;
  }

  /**
   * Deletes a document from the database.
   *
   * @param {DocumentReference} documentRef A reference to the document to be
   * deleted.
   * @param {Precondition=} precondition A precondition to enforce for this
   * delete.
   * @param {Timestamp=} precondition.lastUpdateTime If set, enforces that the
   * document was last updated at lastUpdateTime. Fails the batch if the
   * document doesn't exist or was last updated at a different time.
   * @returns {WriteBatch} This WriteBatch instance. Used for chaining
   * method calls.
   *
   * @example
   * let writeBatch = firestore.batch();
   * let documentRef = firestore.doc('col/doc');
   *
   * writeBatch.delete(documentRef);
   *
   * writeBatch.commit().then(() => {
   *   console.log('Successfully executed batch.');
   * });
   */
  delete<T>(
    documentRef: DocumentReference<T>,
    precondition?: PublicPrecondition
  ): WriteBatch {
    validateDocumentReference('documentRef', documentRef);
    validateDeletePrecondition('precondition', precondition, {optional: true});

    this.verifyNotCommitted();

    const conditions = new Precondition(precondition);

    const op: PendingWriteOp = () => {
      const write: api.IWrite = {delete: documentRef.formattedName};
      if (!conditions.isEmpty) {
        write.currentDocument = conditions.toProto();
      }
      return write;
    };

    this._ops.push(op);

    return this;
  }

  /**
   * Write to the document referred to by the provided
   * [DocumentReference]{@link DocumentReference}.
   * If the document does not exist yet, it will be created. If you pass
   * [SetOptions]{@link SetOptions}., the provided data can be merged
   * into the existing document.
   *
   * @param {DocumentReference} documentRef A reference to the document to be
   * set.
   * @param {T} data The object to serialize as the document.
   * @param {SetOptions=} options An object to configure the set behavior.
   * @param {boolean=} options.merge - If true, set() merges the values
   * specified in its data argument. Fields omitted from this set() call
   * remain untouched.
   * @param {Array.<string|FieldPath>=} options.mergeFields - If provided,
   * set() only replaces the specified field paths. Any field path that is not
   * specified is ignored and remains untouched.
   * @returns {WriteBatch} This WriteBatch instance. Used for chaining
   * method calls.
   *
   * @example
   * let writeBatch = firestore.batch();
   * let documentRef = firestore.doc('col/doc');
   *
   * writeBatch.set(documentRef, {foo: 'bar'});
   *
   * writeBatch.commit().then(() => {
   *   console.log('Successfully executed batch.');
   * });
   */
  set<T>(
    documentRef: DocumentReference<T>,
    data: T,
    options?: SetOptions
  ): WriteBatch {
    validateSetOptions('options', options, {optional: true});
    const mergeLeaves = options && options.merge === true;
    const mergePaths = options && options.mergeFields;
    validateDocumentReference('documentRef', documentRef);
    let firestoreData = documentRef._converter.toFirestore(data);
    validateDocumentData(
      'data',
      firestoreData,
      /* allowDeletes= */ !!(mergePaths || mergeLeaves)
    );

    this.verifyNotCommitted();

    let documentMask: DocumentMask;

    if (mergePaths) {
      documentMask = DocumentMask.fromFieldMask(options!.mergeFields!);
      firestoreData = documentMask.applyTo(firestoreData);
    }

    const transform = DocumentTransform.fromObject(documentRef, firestoreData);
    transform.validate();

    const op: PendingWriteOp = () => {
      const document = DocumentSnapshot.fromObject(documentRef, firestoreData);

      if (mergePaths) {
        documentMask!.removeFields(transform.fields);
      } else if (mergeLeaves) {
        documentMask = DocumentMask.fromObject(firestoreData);
      }

      const write = document.toProto();
      if (!transform.isEmpty) {
        write.updateTransforms = transform.toProto(this._serializer);
      }
      if (mergePaths || mergeLeaves) {
        write.updateMask = documentMask!.toProto();
      }
      return write;
    };

    this._ops.push(op);

    return this;
  }

  /**
   * Update fields of the document referred to by the provided
   * [DocumentReference]{@link DocumentReference}. If the document
   * doesn't yet exist, the update fails and the entire batch will be rejected.
   *
   * The update() method accepts either an object with field paths encoded as
   * keys and field values encoded as values, or a variable number of arguments
   * that alternate between field paths and field values. Nested fields can be
   * updated by providing dot-separated field path strings or by providing
   * FieldPath objects.
   *
   * A Precondition restricting this update can be specified as the last
   * argument.
   *
   * @param {DocumentReference} documentRef A reference to the document to be
   * updated.
   * @param {UpdateData|string|FieldPath} dataOrField An object
   * containing the fields and values with which to update the document
   * or the path of the first field to update.
   * @param {
   * ...(Precondition|*|string|FieldPath)} preconditionOrValues -
   * An alternating list of field paths and values to update or a Precondition
   * to restrict this update.
   * @returns {WriteBatch} This WriteBatch instance. Used for chaining
   * method calls.
   *
   * @example
   * let writeBatch = firestore.batch();
   * let documentRef = firestore.doc('col/doc');
   *
   * writeBatch.update(documentRef, {foo: 'bar'});
   *
   * writeBatch.commit().then(() => {
   *   console.log('Successfully executed batch.');
   * });
   */
  update<T = DocumentData>(
    documentRef: DocumentReference<T>,
    dataOrField: UpdateData | string | FieldPath,
    ...preconditionOrValues: Array<
      {lastUpdateTime?: Timestamp} | unknown | string | FieldPath
    >
  ): WriteBatch {
    // eslint-disable-next-line prefer-rest-params
    validateMinNumberOfArguments('WriteBatch.update', arguments, 2);
    validateDocumentReference('documentRef', documentRef);

    this.verifyNotCommitted();

    const updateMap = new Map<FieldPath, unknown>();
    let precondition = new Precondition({exists: true});

    const argumentError =
      'Update() requires either a single JavaScript ' +
      'object or an alternating list of field/value pairs that can be ' +
      'followed by an optional precondition.';

    const usesVarargs =
      typeof dataOrField === 'string' || dataOrField instanceof FieldPath;

    if (usesVarargs) {
      const argumentOffset = 1; // Respect 'documentRef' in the error message
      const fieldOrValues = [dataOrField, ...preconditionOrValues];
      try {
        for (let i = 0; i < fieldOrValues.length; i += 2) {
          if (i === fieldOrValues.length - 1) {
            const maybePrecondition = fieldOrValues[i];
            validateUpdatePrecondition(i + argumentOffset, maybePrecondition);
            precondition = new Precondition(maybePrecondition);
          } else {
            const maybeFieldPath = fieldOrValues[i];
            validateFieldPath(i + argumentOffset, maybeFieldPath);
            // Unlike the `validateMinNumberOfArguments` invocation above, this
            // validation can be triggered both from `WriteBatch.update()` and
            // `DocumentReference.update()`. Hence, we don't use the fully
            // qualified API name in the error message.
            validateMinNumberOfArguments('update', fieldOrValues, i + 1);

            const fieldPath = FieldPath.fromArgument(maybeFieldPath);
            validateFieldValue(
              i + argumentOffset,
              fieldOrValues[i + 1],
              fieldPath
            );
            updateMap.set(fieldPath, fieldOrValues[i + 1]);
          }
        }
      } catch (err) {
        logger('WriteBatch.update', null, 'Varargs validation failed:', err);
        // We catch the validation error here and re-throw to provide a better
        // error message.
        throw new Error(`${argumentError} ${err.message}`);
      }
    } else {
      try {
        validateUpdateMap('dataOrField', dataOrField);
        // eslint-disable-next-line prefer-rest-params
        validateMaxNumberOfArguments('update', arguments, 3);

        const data = dataOrField as UpdateData;
        Object.keys(data).forEach(key => {
          validateFieldPath(key, key);
          updateMap.set(FieldPath.fromArgument(key), data[key]);
        });

        if (preconditionOrValues.length > 0) {
          validateUpdatePrecondition(
            'preconditionOrValues',
            preconditionOrValues[0]
          );
          precondition = new Precondition(
            preconditionOrValues[0] as {
              lastUpdateTime?: Timestamp;
            }
          );
        }
      } catch (err) {
        logger(
          'WriteBatch.update',
          null,
          'Non-varargs validation failed:',
          err
        );
        // We catch the validation error here and prefix the error with a custom
        // message to describe the usage of update() better.
        throw new Error(`${argumentError} ${err.message}`);
      }
    }

    validateNoConflictingFields('dataOrField', updateMap);

    const transform = DocumentTransform.fromUpdateMap(documentRef, updateMap);
    transform.validate();

    const documentMask = DocumentMask.fromUpdateMap(updateMap);

    const op: PendingWriteOp = () => {
      const document = DocumentSnapshot.fromUpdateMap(documentRef, updateMap);
      const write = document.toProto();
      write.updateMask = documentMask.toProto();
      if (!transform.isEmpty) {
        write.updateTransforms = transform.toProto(this._serializer);
      }
      write.currentDocument = precondition.toProto();
      return write;
    };

    this._ops.push(op);

    return this;
  }

  /**
   * Atomically commits all pending operations to the database and verifies all
   * preconditions. Fails the entire write if any precondition is not met.
   *
   * @returns {Promise.<Array.<WriteResult>>} A Promise that resolves
   * when this batch completes.
   *
   * @example
   * let writeBatch = firestore.batch();
   * let documentRef = firestore.doc('col/doc');
   *
   * writeBatch.set(documentRef, {foo: 'bar'});
   *
   * writeBatch.commit().then(() => {
   *   console.log('Successfully executed batch.');
   * });
   */
  commit(): Promise<WriteResult[]> {
    return this.commit_();
  }

  /**
   * Commits all pending operations to the database and verifies all
   * preconditions.
   *
   * The writes in the batch are not applied atomically and can be applied out
   * of order.
   *
   * @private
   */
  async bulkCommit(): Promise<BatchWriteResult[]> {
    this._committed = true;
    const tag = requestTag();
    await this._firestore.initializeIfNeeded(tag);

    const database = this._firestore.formattedName;
    const request: api.IBatchWriteRequest = {
      database,
      writes: this._ops.map(op => op()),
    };

    const response = await this._firestore.request<
      api.IBatchWriteRequest,
      api.BatchWriteResponse
    >('batchWrite', request, tag);

    return (response.writeResults || []).map((result, i) => {
      let error;
      try {
        const status = response.status[i];
        error = new GoogleError(status.message || undefined);
        error.code = status.code as Status;
      } catch (e) {
        console.log('caught', e);
        error = new Error('lol');
      }
      return new BatchWriteResult(
        result.updateTime ? Timestamp.fromProto(result.updateTime) : null,
        error
      );
    });
  }

  /**
   * Commit method that takes an optional transaction ID.
   *
   * @private
   * @param commitOptions Options to use for this commit.
   * @param commitOptions.transactionId The transaction ID of this commit.
   * @param commitOptions.requestTag A unique client-assigned identifier for
   * this request.
   * @returns  A Promise that resolves when this batch completes.
   */
  async commit_(commitOptions?: {
    transactionId?: Uint8Array;
    requestTag?: string;
  }): Promise<WriteResult[]> {
    // Note: We don't call `verifyNotCommitted()` to allow for retries.
    this._committed = true;

    const tag = (commitOptions && commitOptions.requestTag) || requestTag();
    await this._firestore.initializeIfNeeded(tag);

    const database = this._firestore.formattedName;

    // On GCF, we periodically force transactional commits to allow for
    // request retries in case GCF closes our backend connection.
    const explicitTransaction = commitOptions && commitOptions.transactionId;
    if (!explicitTransaction && this._shouldCreateTransaction()) {
      logger('WriteBatch.commit', tag, 'Using transaction for commit');
      return this._firestore
        .request<api.IBeginTransactionRequest, api.IBeginTransactionResponse>(
          'beginTransaction',
          {database},
          tag
        )
        .then(resp => {
          return this.commit_({transactionId: resp.transaction!});
        });
    }

    const request: api.ICommitRequest = {
      database,
      writes: this._ops.map(op => op()),
    };

    logger(
      'WriteBatch.commit',
      tag,
      'Sending %d writes',
      request.writes!.length
    );

    if (explicitTransaction) {
      request.transaction = explicitTransaction;
    }
    const response = await this._firestore.request<
      api.ICommitRequest,
      api.CommitResponse
    >('commit', request, tag);

    return (response.writeResults || []).map(
      writeResult =>
        new WriteResult(
          Timestamp.fromProto(writeResult.updateTime || response.commitTime!)
        )
    );
  }

  /**
   * Determines whether we should issue a transactional commit. On GCF, this
   * happens after two minutes of idleness.
   *
   * @private
   * @returns Whether to use a transaction.
   */
  private _shouldCreateTransaction(): boolean {
    if (!this._firestore._preferTransactions) {
      return false;
    }

    if (this._firestore._lastSuccessfulRequest) {
      const now = new Date().getTime();
      return now - this._firestore._lastSuccessfulRequest > GCF_IDLE_TIMEOUT_MS;
    }

    return true;
  }

  /**
   * Resets the WriteBatch and dequeues all pending operations.
   * @private
   */
  _reset(): void {
    this._ops.splice(0);
    this._committed = false;
  }
}

/**
 * Validates the use of 'value' as a Precondition and enforces that 'exists'
 * and 'lastUpdateTime' use valid types.
 *
 * @private
 * @param arg The argument name or argument index (for varargs methods).
 * @param value The object to validate
 * @param allowExists Whether to allow the 'exists' preconditions.
 */
function validatePrecondition(
  arg: string | number,
  value: unknown,
  allowExists: boolean
): void {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Input is not an object.');
  }

  const precondition = value as {[k: string]: unknown};

  let conditions = 0;

  if (precondition.exists !== undefined) {
    ++conditions;
    if (!allowExists) {
      throw new Error(
        `${invalidArgumentMessage(
          arg,
          'precondition'
        )} "exists" is not an allowed precondition.`
      );
    }
    if (typeof precondition.exists !== 'boolean') {
      throw new Error(
        `${invalidArgumentMessage(
          arg,
          'precondition'
        )} "exists" is not a boolean.'`
      );
    }
  }

  if (precondition.lastUpdateTime !== undefined) {
    ++conditions;
    if (!(precondition.lastUpdateTime instanceof Timestamp)) {
      throw new Error(
        `${invalidArgumentMessage(
          arg,
          'precondition'
        )} "lastUpdateTime" is not a Firestore Timestamp.`
      );
    }
  }

  if (conditions > 1) {
    throw new Error(
      `${invalidArgumentMessage(
        arg,
        'precondition'
      )} Input specifies more than one precondition.`
    );
  }
}

/**
 * Validates the use of 'value' as an update Precondition.
 *
 * @private
 * @param arg The argument name or argument index (for varargs methods).
 * @param value The object to validate.
 * @param options Optional validation options specifying whether the value can
 * be omitted.
 */
function validateUpdatePrecondition(
  arg: string | number,
  value: unknown,
  options?: RequiredArgumentOptions
): asserts value is {lastUpdateTime?: Timestamp} {
  if (!validateOptional(value, options)) {
    validatePrecondition(arg, value, /* allowExists= */ false);
  }
}

/**
 * Validates the use of 'value' as a delete Precondition.
 *
 * @private
 * @param arg The argument name or argument index (for varargs methods).
 * @param value The object to validate.
 * @param options Optional validation options specifying whether the value can
 * be omitted.
 */
function validateDeletePrecondition(
  arg: string | number,
  value: unknown,
  options?: RequiredArgumentOptions
): void {
  if (!validateOptional(value, options)) {
    validatePrecondition(arg, value, /* allowExists= */ true);
  }
}

/**
 * Validates the use of 'value' as SetOptions and enforces that 'merge' is a
 * boolean.
 *
 * @private
 * @param arg The argument name or argument index (for varargs methods).
 * @param value The object to validate.
 * @param options Optional validation options specifying whether the value can
 * be omitted.
 * @throws if the input is not a valid SetOptions object.
 */
export function validateSetOptions(
  arg: string | number,
  value: unknown,
  options?: RequiredArgumentOptions
): void {
  if (!validateOptional(value, options)) {
    if (!isObject(value)) {
      throw new Error(
        `${invalidArgumentMessage(
          arg,
          'set() options argument'
        )} Input is not an object.`
      );
    }

    const setOptions = value as {[k: string]: unknown};

    if ('merge' in setOptions && typeof setOptions.merge !== 'boolean') {
      throw new Error(
        `${invalidArgumentMessage(
          arg,
          'set() options argument'
        )} "merge" is not a boolean.`
      );
    }

    if ('mergeFields' in setOptions) {
      if (!Array.isArray(setOptions.mergeFields)) {
        throw new Error(
          `${invalidArgumentMessage(
            arg,
            'set() options argument'
          )} "mergeFields" is not an array.`
        );
      }

      for (let i = 0; i < setOptions.mergeFields.length; ++i) {
        try {
          validateFieldPath(i, setOptions.mergeFields[i]);
        } catch (err) {
          throw new Error(
            `${invalidArgumentMessage(
              arg,
              'set() options argument'
            )} "mergeFields" is not valid: ${err.message}`
          );
        }
      }
    }

    if ('merge' in setOptions && 'mergeFields' in setOptions) {
      throw new Error(
        `${invalidArgumentMessage(
          arg,
          'set() options argument'
        )} You cannot specify both "merge" and "mergeFields".`
      );
    }
  }
}

/**
 * Validates a JavaScript object for usage as a Firestore document.
 *
 * @private
 * @param arg The argument name or argument index (for varargs methods).
 * @param obj JavaScript object to validate.
 * @param allowDeletes Whether to allow FieldValue.delete() sentinels.
 * @throws when the object is invalid.
 */
export function validateDocumentData(
  arg: string | number,
  obj: unknown,
  allowDeletes: boolean
): void {
  if (!isPlainObject(obj)) {
    throw new Error(customObjectMessage(arg, obj));
  }

  for (const prop of Object.keys(obj)) {
    validateUserInput(
      arg,
      obj[prop],
      'Firestore document',
      {
        allowDeletes: allowDeletes ? 'all' : 'none',
        allowTransforms: true,
      },
      new FieldPath(prop)
    );
  }
}

/**
 * Validates that a value can be used as field value during an update.
 *
 * @private
 * @param arg The argument name or argument index (for varargs methods).
 * @param val The value to verify.
 * @param path The path to show in the error message.
 */
export function validateFieldValue(
  arg: string | number,
  val: unknown,
  path?: FieldPath
): void {
  validateUserInput(
    arg,
    val,
    'Firestore value',
    {allowDeletes: 'root', allowTransforms: true},
    path
  );
}

/**
 * Validates that the update data does not contain any ambiguous field
 * definitions (such as 'a.b' and 'a').
 *
 * @private
 * @param arg The argument name or argument index (for varargs methods).
 * @param data An update map with field/value pairs.
 */
function validateNoConflictingFields(
  arg: string | number,
  data: UpdateMap
): void {
  const fields: FieldPath[] = [];
  data.forEach((value, key) => {
    fields.push(key);
  });

  fields.sort((left, right) => left.compareTo(right));

  for (let i = 1; i < fields.length; ++i) {
    if (fields[i - 1].isPrefixOf(fields[i])) {
      throw new Error(
        `${invalidArgumentMessage(arg, 'update map')} Field "${
          fields[i - 1]
        }" was specified multiple times.`
      );
    }
  }
}

/**
 * Validates that a JavaScript object is a map of field paths to field values.
 *
 * @private
 * @param arg The argument name or argument index (for varargs methods).
 * @param obj JavaScript object to validate.
 * @throws when the object is invalid.
 */
function validateUpdateMap(arg: string | number, obj: unknown): void {
  if (!isPlainObject(obj)) {
    throw new Error(customObjectMessage(arg, obj));
  }

  let isEmpty = true;
  if (obj) {
    for (const prop of Object.keys(obj)) {
      isEmpty = false;
      validateFieldValue(arg, obj[prop], new FieldPath(prop));
    }
  }

  if (isEmpty) {
    throw new Error('At least one field must be updated.');
  }
}
