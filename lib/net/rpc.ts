/// <reference path="../../typings/DefinitelyTyped/chrome/chrome.d.ts" />

/** `rpc` provides an interface for making RPC calls between
  * isolated objects such as two Windows in different domains,
  * workers or browser extension scripts and web front-ends etc.
  *
  * This module uses callbacks rather than promises for portability
  * between different Javascript environments (standard browser
  * context, web workers, priviledged extension scripts, sandboxed
  * 'content' scripts in browser extensions etc.)
  */

/** Client provides a call() method to invoke an RPC
  * call on the server and receive a promise for the result.
  */
export interface Client {
	/** Invoke an RPC call and invoke callback with the results.
	  * The values in the arguments array are passed to handler registered
	  * with Server.on() for the given method.
	  *
	  * The optional timeout specifies the time interval within which
	  * a reply should be received if @p callback is specified.
	  *
	  * If no reply is received within the timeout, @p callback is invoked
	  * with a timeout error. If @p timeout is null, a default timeout
	  * is used.
	  */
	call<R>(method: string, args: any[], callback?: (err: any, result: R) => void,
	        timeout?: number) : void;
}

/** Provides an interface for handling an RPC call.
  */
export interface Server {
	/** Register a synchronous RPC handler. If a client runs Client.call() with
	  * a matching the method name, @p handler will be invoked with the supplied
	  * arguments. Any exception thrown will be converted to an error returned
	  * via the callback passed to Client.call()
	  */
	on<R>(method: string, handler: (...args: any[]) => R) : void;
	/** Register an async RPC handler. This is similar to on() except that
	  * instead of returning a value or throwing an exception, onAsync()
	  * should call done() with the error or result when finished.
	  *
	  * If the handler throws an exception directly, that is equivalent to
	  * calling done() with the exception.
	  */
	onAsync<R>(method: string, handler: (done: (err: any, result: R) => void, ...args: any[]) => void) : void;
}

export interface Message {
	id: number;
	method: string;
}

export interface CallMessage extends Message {
	payload: any[];
}

export interface ReplyMessage extends Message {
	err: any;
	result: any;
}

/** Interface for sending and receiving messages to/from a remote
  * object such as a window or web worker.
  */
export interface MessagePort<Call,Reply> {
	on(method: string, handler: Function) : void;
	on(method: 'rpc-call', handler: (call: Call) => void) : void;
	on(method: 'rpc-reply', handler: (reply: Reply) => void) : void;

	emit(method: string, data: Object) : void;
	emit(method: 'rpc-call', data: Call) : void;
	emit(method: 'rpc-reply', data: Reply) : void;
}

/** Subset of the DOM Window interface related to sending and receiving
  * messages to/from other windows.
  */
export interface WindowMessageInterface {
	addEventListener(event: string, handler: Function) : void;
	addEventListener(event: 'message', handler: (ev: MessageEvent) => any) : void;
	postMessage(message: any, targetOrigin: string) : void;
}

/** A MessagePort implementation which uses the Window.postMessage() and
  * Window.addEventListener() APIs for use with RpcHandler.
  *
  * A WindowMessagePort has a send-tag and a receive-tag.
  * The send-tag is included with all messages emitted via emit().
  *
  * The port will only invoke handlers passed to on() if the message's
  * tag matches the WindowMessagePort's receive-tag.
  */
export class WindowMessagePort {
	constructor(public window: WindowMessageInterface,
	            public targetOrigin: string,
	            public sendTag: string,
				public receiveTag: string) {
	}

	on(method: string, handler: Function) : void {
		this.window.addEventListener('message', (ev: MessageEvent) => {
			if (typeof ev.data.rpcMethod !== 'undefined' &&
			    typeof ev.data.tag !== 'undefined' &&
				ev.data.rpcMethod == method &&
				ev.data.tag == this.receiveTag) {
				handler(ev.data.data);
			}
		});
	}

	emit(method: string, data: Object) : void {
		this.window.postMessage({
			rpcMethod: method,
			data: data,
			tag: this.sendTag
		}, this.targetOrigin);
	}
}

export class WorkerMessagePort {
	constructor(public worker: Worker, public sendTag: string, public receiveTag: string) {
	}

	on(method: string, handler: Function) {
		this.worker.addEventListener('message', (ev: MessageEvent) => {
			if (typeof ev.data.rpcMethod !== 'undefined' &&
			    typeof ev.data.tag !== 'undefined' &&
			    ev.data.rpcMethod == method &&
			    ev.data.tag == this.receiveTag) {
				handler(ev.data.data);
			}
		});
	}

	emit(method: string, data: Object) {
		this.worker.postMessage({rpcMethod: method, data: data, tag: this.sendTag});
	}
}

interface ChromeEvent extends chrome.events.Event {
	addListener(callback: (message: any, sender: any, reply: any) => void): void;
}

export class ChromeMessagePort {
	constructor(public targetTab?: number) {
	}

	on(method: string, handler: Function) : void {
		var onMessage = <ChromeEvent>chrome.runtime.onMessage;
		onMessage.addListener((msg, sender) => {
			if (typeof msg.rpcMethod !== 'string' ||
			    msg.rpcMethod != method) {
				return;
			}
			if (this.targetTab) {
				if (!sender.tab || sender.tab.id != this.targetTab) {
					return;
				}
			}
			handler(msg.data);
		});
	}

	emit(method: string, data: Object) : void {
		var payload = {
			rpcMethod: method,
			data: data
		};
		if (this.targetTab) {
			chrome.tabs.sendMessage(this.targetTab, payload);
		} else {
			chrome.runtime.sendMessage(payload);
		}
	}
}

interface PendingRpcCall {
	id: number;
	method: string;
	callback?: Function;

	// ID of timeout timer to verify that RPC calls are replied
	// to.
	//
	// Note: Type here is set to 'any' to avoid need to import
	// Node.js typings when compiling Firefox addon SDK

	replyTimerId?: any; /* NodeJS.Timer | number */
}

/** Interface for object providing timer APIs, which may
  * either be 'window' (in a browser context), 'global' (in Node)
  * or something else (eg. in a Firefox addon)
  */
interface Timers {
	setTimeout(callback: () => void, ms: number): any;
	clearTimeout(id: any): void;
}

// 'global' var for use in NodeJS. This file does
// not reference NodeJS' typings directly to avoid
// conflicts with require() in Firefox addon typings
declare var global: Timers;

/** Simple RPC implementation. RpcHandler implements both the
  * client and server-sides of an RPC handler.
  */
export class RpcHandler implements Client, Server {
	private replyId: number;
	private id: number;
	private pending: PendingRpcCall[];
	private port: MessagePort<CallMessage, ReplyMessage>;
	private handlers: {
		method: string;
		callback: (args: any) => any;
		isAsync: boolean;
	}[];
	private timers: Timers;

	/** A handler responsible for performing any special copying
	  * of method arguments or replies needed before the data
	  * is sent to the message port.
	  *
	  * For example in the Firefox extension objects being passed
	  * from priviledged add-on code to pages needs to be copied
	  * using cloneInto().
	  */
	clone: (data: any) => any;

	/** Construct an RPC handler which uses @p port to send and receive
	  * messages to/from the other side of the connection.
	  */
	constructor(port: MessagePort<CallMessage, ReplyMessage>, timers?: Timers) {
		this.port = port;

		if (timers) {
			this.timers = timers;
		} else if (typeof window !== 'undefined') {
			// default to using window.setTimeout() in browser
			this.timers = window;
		} else if (typeof global !== 'undefined') {
			// default to global.setTimeout() in Node
			this.timers = global;
		}

		this.id = 1;
		this.handlers = [];
		this.pending = [];
		this.clone = (data) => {
			return data;
		};

		this.port.on('rpc-reply', (reply: ReplyMessage) => {
			var pending = this.pending.filter((pending) => {
				return pending.id == reply.id;
			});
			if (pending.length != 1) {
				throw new Error('No matching RPC call found for method: ' + reply.method)
			}
			if (pending[0].callback) {
				pending[0].callback(reply.err, reply.result);
			}
		});

		this.port.on('rpc-call', (call: CallMessage) => {
			var handled = false;
			this.handlers.forEach((handler) => {
				if (handler.method == call.method) {
					var done = (err: any, result: any) => {
						this.port.emit('rpc-reply', {
							id: call.id,
							method: call.method,
							err: this.clone(err),
							result: this.clone(result)
						});
					};

					try {
						if (handler.isAsync) {
							handler.callback.apply(null, [done].concat(call.payload));
						} else {
							var result = handler.callback.apply(null, call.payload);
							done(null, result);
						}
					} catch (err) {
						done(err, null);
					}

					handled = true;
				}
			});
			if (!handled) {
				throw new Error('No handler found for method: ' + call.method);
			}
		});
	}

	call<R>(method: string, args: any[], callback?: (err: any, result: R) => void,
	        timeout?: number) {
		var call = {
			id: ++this.id,
			method: method,
			payload: args
		};

		var pending: PendingRpcCall = {
			id: call.id,
			method: method
		};

		if (callback) {
			timeout = timeout || 5000;
			pending.callback = (err: any, result: R) => {
				this.timers.clearTimeout(<number>pending.replyTimerId);
				callback(err, result);
			};
			pending.replyTimerId = this.timers.setTimeout(() => {
				callback(new Error(`RPC call ${method} did not receive a reply within ${timeout} ms`),
				  null);
				console.warn('rpc-call %s did not receive a reply within %d ms', method, timeout);
			}, timeout)
		}

		this.pending.push(pending);
		this.port.emit('rpc-call', call);
	}

	on<R>(method: string, handler: (...args: any[]) => R) {
		this.handlers.push({
			method: method,
			callback: handler,
			isAsync: false
		});
	}

	onAsync<R>(method: string, handler: (done: (err: any, result: R) => void, ...args: any[]) => void) {
		this.handlers.push({
			method: method,
			callback: handler,
			isAsync: true
		});
	}
}

