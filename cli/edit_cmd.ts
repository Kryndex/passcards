import argparse = require('argparse');
import sprintf = require('sprintf');
import underscore = require('underscore');

import consoleio = require('./console');
import item_search = require('../lib/item_search');
import item_store = require('../lib/item_store');

var NO_SUCH_SECTION_ERROR = 'No matching section found';
var NO_SUCH_FIELD_ERROR = 'No matching field found';
var UNKNOWN_FIELD_TYPE_ERROR = 'Unsupported field type';

export class EditCommand {
	private io: consoleio.TermIO;
	private passwordGenerator: () => string;

	parser: argparse.ArgumentParser;

	constructor(io: consoleio.TermIO, cmd: argparse.Subparsers, passwordGenerator: () => string) {
		this.io = io;
		this.passwordGenerator = passwordGenerator;

		this.parser = cmd.addParser('edit', {
			description: 'Edit an existing item in the vault'
		});
		this.parser.addArgument(['item'], {
			action: 'store',
			help: 'Pattern specifying the item'
		});
		var editCmds = this.parser.addSubparsers({ dest: 'action' });

		// commands for renaming items
		var renameCmd = editCmds.addParser('rename');
		renameCmd.addArgument(['new_name'], {
			help: 'New name for the item'
		});

		// commands for adding sections and fields
		var addSectionCmd = editCmds.addParser('add-section');
		addSectionCmd.addArgument(['section'], {
			help: 'Title of the new section'
		});

		var addFieldCmd = editCmds.addParser('add-field');
		addFieldCmd.addArgument(['section'], {
			help: 'Pattern specifying the section to add a field to'
		});
		addFieldCmd.addArgument(['field'], {
			help: 'Title of the new field'
		});
		addFieldCmd.addArgument(['-t', '--type'], {
			action: 'store',
			nargs: 1,
			dest: 'type',
			help: 'Type of data for this item',
			defaultValue: ['text'],
			choices: ['text', 'password']
		});
		addFieldCmd.addArgument(['value'], {
			action: 'store',
			nargs: '*'
		});

		// commands for updating sections and fields
		var renameSectionCmd = editCmds.addParser('rename-section');
		renameSectionCmd.addArgument(['section'], {
			help: 'Pattern specifying section to rename'
		});
		renameSectionCmd.addArgument(['new_name']);

		var setFieldCmd = editCmds.addParser('set-field');
		setFieldCmd.addArgument(['field'], {
			help: 'Pattern specifying field to update'
		});
		setFieldCmd.addArgument(['value'], {
			action: 'store',
			nargs: '*'
		});

		var removeFieldCmd = editCmds.addParser('remove-field');
		removeFieldCmd.addArgument(['field'], {
			help: 'Pattern specifying field to remove'
		});

		// TODO - Add commands for:
		// - Renaming fields
		// - Removing sections
	}

	handle(args: any, item: item_store.Item): Promise<void> {
		var content: item_store.ItemContent;
		return item.getContent().then((_content) => {
			content = _content;
			switch (args.action) {
				case 'rename':
					return this.rename(item, args.new_name);
				case 'add-section':
					return this.addSection(content, args.section);
				case 'add-field':
					return this.addField(content, args.section, args.field, args.type[0], args.value.join(' '));
				case 'rename-section':
					return this.renameSection(content, args.section, args.new_name);
				case 'set-field':
					return this.setField(content, args.field, args.value.join(' '));
				case 'remove-field':
					return this.removeField(content, args.field);
				default:
					return undefined;
			}
		}).then(() => {
			item.setContent(content);
			return item.save();
		});
	}

	private selectField(content: item_store.ItemContent, field: string): item_search.FieldMatch {
		var matches = item_search.matchField(content, field);
		return matches.length > 0 ? matches[0] : null;
	}

	private rename(item: item_store.Item, newTitle: string): Promise<void> {
		var title = newTitle.trim();
		if (title.length < 1) {
			throw new Error('New item name must not be empty');
		}
		item.title = title;
		return null;
	}

	private addSection(content: item_store.ItemContent, sectionTitle: string): Promise<void> {
		content.sections.push({
			name: sectionTitle,
			title: sectionTitle,
			fields: []
		});
		return null;
	}

	private addField(content: item_store.ItemContent, sectionName: string, fieldTitle: string, typeName: string,
		value: string): Promise<void> {
		let sections = item_search.matchSection(content, sectionName);
		if (sections.length == 0) {
			return Promise.reject<void>(NO_SUCH_SECTION_ERROR);
		}

		let fieldTypes: { [index: string]: item_store.FieldType } = {
			'text': item_store.FieldType.Text,
			'password': item_store.FieldType.Password
		};
		if (fieldTypes[typeName] === undefined) {
			return Promise.reject<void>(UNKNOWN_FIELD_TYPE_ERROR);
		}

		let section = sections[0];
		let field = {
			name: fieldTitle, // FIXME - Should this be an ID?
			kind: fieldTypes[typeName],
			title: fieldTitle,
			value
		};
		section.fields.push(field);

		return null;
	}

	private renameSection(content: item_store.ItemContent, section: string, newName: string): Promise<void> {
		return Promise.reject<void>(null);
	}

	private setField(content: item_store.ItemContent, field: string, newValue: string): Promise<void> {
		var match = this.selectField(content, field);
		if (match) {
			if (newValue) {
				match.setValue(newValue);
				return Promise.resolve<void>(null);
			} else {
				var newValPromise: Promise<string>;
				if (match.isPassword()) {
					newValPromise = consoleio.passwordFieldPrompt(this.io, this.passwordGenerator);
				} else {
					newValPromise = this.io.readLine(sprintf('New value for "%s">', match.name()));
				}
				return newValPromise.then((newValue) => {
					match.setValue(newValue);
					return Promise.resolve<void>(null);
				});
			}
		} else {
			return Promise.reject<void>(NO_SUCH_FIELD_ERROR);
		}
	}

	private removeField(content: item_store.ItemContent, field: string): Promise<void> {
		var match = this.selectField(content, field);
		if (!match) {
			return Promise.reject<void>(NO_SUCH_FIELD_ERROR);
		}
		match.section.fields = underscore.filter(match.section.fields, (field) => {
			return field != match.field;
		});
		return Promise.resolve<void>(undefined);
	}
}
