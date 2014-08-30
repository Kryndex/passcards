import react = require('react');
import tsutil = require('../lib/base/tsutil');

/** Merge props passed to a parent component with those set in a child
  * component.
  *
  * Props set in @p childProps override those set in @p parentProps with
  * the exception of 'className' where the value in @p parentProps and
  * the value in @p childProps are concatenated.
  */
export function mergeProps<P,C>(parentProps: P, childProps: C) : C {
	var childMap = tsutil.unsafeCast<C, {[index:string] : any}>(childProps);
	var parentMap = tsutil.unsafeCast<P, {[index:string] : any}>(parentProps);

	for (var k in parentMap) {
		if (!childMap.hasOwnProperty(k)) {
			childMap[k] = parentMap[k];
		} else if (k == 'className') {
			childMap[k] = childMap[k] + ' ' + parentMap[k];
		}
	}

	return childProps;
}

/** Converts a map of (component name -> unmounted React component)
  * into an array of components where the map key is set
  * as the 'key' attribute of the component's props.
  *
  * The ordering of the components in the result array is arbitrary.
  */
export function mapToComponentArray(map: Object) {
	var ary: Array<react.ReactComponent<any,any>> = [];
	Object.keys(map).forEach((k) => {
		var child = (<any>map)[k];
		child.props.key = k;
		ary.push(child);
	});
	return ary;
}
