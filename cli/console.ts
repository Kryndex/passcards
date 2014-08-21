/// <reference path="../typings/DefinitelyTyped/promptly/promptly.d.ts" />
/// <reference path="../typings/DefinitelyTyped/node/node.d.ts" />
/// <reference path="../typings/DefinitelyTyped/q/Q.d.ts" />
/// <reference path="../typings/sprintf.d.ts" />

import promptly = require('promptly');
import sprintf = require('sprintf');
import Q = require('q');

import asyncutil = require('../lib/base/asyncutil');

/** Interface for terminal input/output. */
export interface TermIO {
	print(text: string) : void
	readPassword(prompt: string) : Q.Promise<string>
	readLine(prompt: string) : Q.Promise<string>
}

export class ConsoleIO implements TermIO {
	print(text: string) : void {
		console.log(text);
	}

	readPassword(prompt: string) : Q.Promise<string> {
		var result = Q.defer<string>();
		promptly.password(prompt, (err, password) => {
			if (err) {
				result.reject(err);
				return;
			}
			result.resolve(password);
		});
		return result.promise;
	}

	readLine(prompt: string) : Q.Promise<string> {
		var result = Q.defer<string>();
		promptly.prompt(prompt, (err, text) => {
			if (err) {
				result.reject(err);
				return;
			}
			result.resolve(text);
		});
		return result.promise;
	}
}

export function printf(out: TermIO, format: string, ...args: any[]) {
	out.print(sprintf.apply(null, [format].concat(args)));
}

export function passwordFieldPrompt(io: TermIO, randomPassFunc : () => string) : Q.Promise<string> {
	var password : string;
	return asyncutil.until(() => {
		return io.readPassword("Password (or '-' to generate a random password): ").then((passOne) => {
			if (passOne == '-') {
				password = randomPassFunc();
				return Q(true);
			} else {
				return io.readPassword('Re-enter password: ').then((passTwo) => {
					if (passTwo == passOne) {
						password = passOne;
						return true;
					} else {
						printf(io, 'Passwords do not match');
						return false;
					}
				});
			}
		});
	}).then(() => {
		return password;
	});
}

