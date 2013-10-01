/**
 * iOS backend generator
 */
var fs = require('fs'),
	path = require('path'),
	ejs = require('ejs'),
	semver = require('semver'),
	wrench = require('wrench'),
	_ = require('underscore'),
	log = require('../../log'),
	interface_to_native_class_template = fs.readFileSync(path.join(__dirname,'templates','interface_to_native_class.ejs')).toString(),
	interface_to_native_class_header_template = fs.readFileSync(path.join(__dirname,'templates','interface_to_native_class_header.ejs')).toString(),
	class_template = fs.readFileSync(path.join(__dirname,'templates','implementation.ejs')).toString(),
	header_template = fs.readFileSync(path.join(__dirname,'templates','header.ejs')).toString(),
	struct_template = fs.readFileSync(path.join(__dirname,'templates','struct.ejs')).toString(),
	struct_header_template = fs.readFileSync(path.join(__dirname,'templates','struct_header.ejs')).toString(),
	typedef_template = fs.readFileSync(path.join(__dirname,'templates','typedef.ejs')).toString(),
	typedef_header_template = fs.readFileSync(path.join(__dirname,'templates','typedef_header.ejs')).toString(),
	type_to_native_template = fs.readFileSync(path.join(__dirname,'templates','type_to_native.ejs')).toString(),
	primitiveTypeRegex = /^(un)?(signed)?\s*(short|float|double|long|bool|int|char|unichar|_Bool)/i,
	voidpointerRegex = /^(const)?\s*void\s?\*?/,
	subarrayRegex = /(un?signed)?\s*(\w+)\s*\[(\d+)?\]/,
	signedRegex = /(un?signed )/,
	protocolRegex = /(\w+)<(.*)>/,
	INDENT = '    ',
	CLASS_CONVERTER_FILENAME = 'class_converters.h';

exports.compile = compile;

/**
 * translate from one type to another
 */
const TRANSLATED_TYPES = {
};

/**
 * these classes are not available 
 */
const BLACKLIST_CLASSES = [
	'Protocol',
	'NSSocketPort',	 // not available on iOS, although clang says it is
	'NSPortMessage'	 // not available on iOS, although clang says it is
];


/**
 * turn a string of content into a string with each line with an indent
 */
function indentify(string, indent) {
	indent = indent || INDENT;
	var c = 0;
	return string.split(/\n/).map(function(s){ return ((c++ > 0) ? indent : '') + s }).join('\n');
}

/**
 * taken a type (such as const char * or UIView *) return a stripped down type removing all the 
 * extra fluff like const and signed attributes that are modifiers to the type object.
 */
function convertToSimpleType (type) {
	var t = type.replace('unsigned ','')
				.replace('signed ','')
				.replace('struct ','')
				.replace('union ','')
				.replace('enum ','')
				.replace(/__unsafe_unretained/g,'')
				.replace(/__strong/g,'')
				.replace('volatile','')
				.replace('*const','')
				.replace('const ','')
				.replace(/\*/g,'')
				.trim();
	if (t in TRANSLATED_TYPES) {
		return TRANSLATED_TYPES[t];
	}
	return t;
}

/**
 * create a mangled symbol name from a fully qualified type (such as const char *) 
 */
function mangleTypeName (type) {
	return type.replace(/[\(\)\[\]\s,<>\.]/g, '_').replace(/\^/g,'B').replace(/\*/g,'P');
}

/**
 * return true if symbol is referenced
 */
function isSymbolReferenced (state, classname, name, type) {
	var simpleName = convertToSimpleType(classname),
		referenced = state.referenceTable && state.referenceTable[simpleName],
		types = referenced && referenced[type];
		found = types && types.indexOf(name)!==-1;

	// if found or if we're compiling in all symbols (denoted by missing referenceTable)
	return (found || state.referenceTable===undefined);
}

/**
 * create a state object that we can use during compilation and that can be passed along to functions
 */
function createState (metadata, version, referenceTable) {
	return {
		metadata: metadata,
		version: version,
		dependencies: [],
		externs: {},
		imports: {},
		typedefs: {},
		referenceTable: referenceTable,
		addImports: true
	};
}

/**
 * check if version is supported
 */
function satisfies (check, version) {
	if (!check || check==='0') return false;
	check = makeVersion(check);
	version = makeVersion(version);
	return semver.gte(version,check);
}

/**
 * iOS versions can be in the form X.X but semver requires X.X.X
 */
function makeVersion (version) {
	if (version.split('.').length===2) {
		version+='.0';
	}
	return version;
}

/**
 * return true if this metadata type is available on this platform, version
 */
function available(obj, version) {
	if (!obj) throw new Error('object cannot be null');
	var availability = obj.availability;
	if (availability && (availability.message==='Unavailable' || availability.platform!=='ios')) {
		return false;
	}
	if (obj.unavailable) {
		return false;
	}
	if (availability && satisfies(availability.deprecated,version)) {
		return false;
	}
	return true;
}

/**
 * return true if a method prototype is found
 */
function hasMethodPrototype(metadata,entry,name) {
	var e = entry;
	while(entry) {
		if (entry.methods && name in entry.methods) {
			return true;
		}
		entry = metadata.classes[entry.superClass];
	}
	return false;
}


/**
 * this method will attempt to resolve all graph dependencies for a given symbol.  for example, if the type is a class, it will 
 * examine all methods and properties to resolve any dependencies found in method signatures, return types, etc.  the dependencies
 * argument should be a object literal that will be populated with any dependencies required in the graph.  the key is the 
 * full type and the value is the result of this function which is a meta object that has enough information to generate code
 * for this type.
 */
function resolveType (state, type) {
	//console.error('resolveType=',type);
	type = type.trim();
	// if we've already mapped it, just return it
	if (type in state.dependencies) {
		return state.dependencies[type];
	}
	// turn the type into something that we can lookup -- for example, strip all the extra typing information that isn't important to convert this type object into a type we can deal with
	var simpleType = convertToSimpleType(type),
		metadata = state.metadata,
		classObject = metadata.classes[simpleType],
		protoObject = !classObject && metadata.protocols[simpleType],
		typedObject = !protoObject && metadata.types[type] || metadata.types[simpleType],
		symbolObject = !typedObject && metadata.symbols[simpleType],
		typeObject = classObject || protoObject || typedObject || symbolObject,
		is_function_pointer = type.indexOf('(*)')>0,
		is_block = !is_function_pointer && type.indexOf('(^)')>0,
		is_pointer = !is_function_pointer && !is_block && type.indexOf('*')>0,
		is_void = !is_function_pointer && !is_block && voidpointerRegex.test(type),
		is_void_pointer = is_void && is_pointer,
		is_pointer_to_pointer = is_pointer && type.indexOf('**')>0,
		is_primitive = !is_function_pointer && !is_block && primitiveTypeRegex.test(simpleType),
		is_object = !!(classObject || protoObject),
		is_protocol = !is_function_pointer && !is_block && protocolRegex.test(type),
		is_interface = !!classObject,
		is_array = is_primitive && subarrayRegex.test(type),
		is_const = type.indexOf('const ')!==-1,
		is_char_array = is_array && /char/.test(simpleType),
		is_struct = (typedObject && ((typedObject.type && typedObject.type.indexOf('struct ')!==-1) || (typedObject.subtype && typedObject.subtype.indexOf('struct ')!==-1))),
		is_enum = (typedObject && typedObject.metatype=='enum' ||  typedObject && ((typedObject.type && typedObject.type.indexOf('enum ')!==-1) || (typedObject.subtype && typedObject.subtype.indexOf('enum ')!==-1))),
		name = (typedObject && typedObject.alias) || type,  
		mangled = mangleTypeName(name);

	// check to see if it's blacklisted
	if (BLACKLIST_CLASSES.indexOf(simpleType)!==-1) {
		return null;
	}
	if (is_object && type in state.dependencies) {
		return state.dependencies[type];
	}
	// we shouldn't get here but sometimes we can if we have an issue or a bad type that clang is not reporting correctly
	if (!is_void && !is_function_pointer && !typeObject && !is_primitive && !is_block && !is_protocol && !is_void_pointer) {
		//console.error("Couldn't seem to determine the type for '"+type+"'");
		return null;
	}
	// if we have an alias and this is a pointer type, we need to make sure the alias is a pointer too
	if (typedObject && typedObject.alias) {
		if (type != typedObject.type) {
			name = typedObject.alias + (is_pointer ? ' *' : '');
			mangled = mangleTypeName(name);			
		}
	}
	if (!is_primitive && typeObject && typeObject.metatype==='typedef' && primitiveTypeRegex.test(typeObject.type)) {
		is_primitive = true;
		is_struct = false;
	}
	// this meta object will give us enough information about the typing to be able to generate code
	var result = {
		metatype: is_enum ? 'enum' : is_struct ? 'struct' : is_primitive ? 'primitive' : classObject ? 'interface' : protoObject ? 'protocol' : typedObject ? 'typedef' : symbolObject ? 'symbol' : is_protocol ? 'protocol' : is_function_pointer ? 'function_pointer' : is_block ? 'block' : 'other',
		realtype: type,
		type: name,
		name: name,
		simpleType: simpleType,
		is_void: is_void,
		object: typeObject,
		is_function_pointer: is_function_pointer,
		is_block: is_block,
		is_pointer: is_pointer,
		is_void_pointer: is_void_pointer,
		is_pointer_to_pointer: is_pointer_to_pointer,
		is_primitive: is_primitive,
		is_protocol: is_protocol,
		is_object: is_object,
		is_array: is_array,
		is_const: is_const,
		is_char_array: is_char_array,
		mangledName: mangled   //mangle the name so we can build a consistent and safe function name from it
	};
	// check to see if we have an alias and if so, resolve to it
	if (typedObject && typedObject.alias && simpleType!=typedObject.alias) {
		return resolveType(state,typedObject.alias);
	}
	// turn a NSString ** to NSString *
	if (is_pointer_to_pointer) {
		result.name = result.type = type.replace('**','*');
		result.mangledName = mangleTypeName(result.type);
	}
	if (is_object && !is_pointer_to_pointer) {
		// if an protocol or class, insert with just plain Class name
		state.dependencies[simpleType] = result;
	}
	// if we're an interface or protocol, just use the simpleType as the key
	if (!(type in state.dependencies)) {
		state.dependencies[type] = result;
	}

	if (is_char_array) {
		var sub = subarrayRegex.exec(type),
			length = parseInt(sub[2])||0;
		// unsigned char[16] -> unsigned char as simpleType
		result.simpleType = simpleType = sub[1];
		result.length = length;
		result.type = result.name = simpleType+' *';
	}
	else if (is_array) {
		var m = subarrayRegex.exec(type),
			length = parseInt(m[3])||0;
		result.simpleType = simpleType = ((m[1]||'') +' ' + m[2]).trim();
		result.type = type = result.name = simpleType+' *';
		result.is_pointer = true;
		result.length = length;
		// force a dependency analysis
		resolveType(state, type);
	}
	else if (is_protocol) {
		var m = protocolRegex.exec(type),
			cls = m[1],
			protonames = m[2].split(','),
			interf = metadata.classes[cls] || metadata.protocols[cls] || {'metatype':'id'},
			protocols = [];
		protonames.forEach(function(n) {
			var p = resolveType(state, n);
			protocols.push(p);
		});
		result.protocols = protocols;
		result.protocolNames = protonames;
		result.baseObject = resolveType(state, cls);

		// merge the base object also with the protocols
		var newobj = _.clone(result.baseObject);
		protocols.forEach(function(p) {
			newobj = _.defaults(newobj, p.object);
		});

		result.object = newobj;

		// turn id base object into NSObject pointer
		if (cls==='id') {
			result.name = 'NSObject<'+m[2]+'>';
		}
		else {
			result.name = type;
		}
		if (!is_pointer && result.name.indexOf('*')===-1 && cls!=='Class') {
			result.name+=' *';
		}
		else if (cls==='Class') {
			// if the base is Class *, we need to remove the *
			result.name = result.type = result.name.replace(' *','').trim();
		}
		// force a dependency analysis
		resolveType(state, result.name);
	}
	else if (is_interface) {
		result.mangledName = mangleTypeName(simpleType);
		if (!is_pointer && result.name.indexOf('*')===-1) {
			// create a valid object pointer
			result.name+=' *';
			result.type=result.name;
		}
	}
	else if (protoObject) {
		result.name = 'NSObject<'+type+'> *';
		result.type = result.name;
		result.baseObject = resolveType(state,'NSObject');
		result.protocolNames = [type];
	}
	else if (is_block) {
		var i = type.indexOf('(^)'),
			rt = type.substring(0,i),
			args = type.substring(i+4,type.length-1).split(',').map(function(n){ return n.trim() });
		result.blockArgs = [];
		result.blockReturnType = resolveType(state, rt);
		args.forEach(function(n){
			if (n==='...') {
				result.is_vararg = true;
				result.blockArgs.push({metatype:'sentinel'});
				return;
			}
			var a = resolveType(state, n);
			result.blockArgs.push(a);
		});
		var blockargs = result.blockArgs.map(function(a){return a.type}),
			blocktypedef = 'Block_'+result.mangledName,
			typedef = 'typedef '+result.blockReturnType.type+' (^'+blocktypedef+')('+args.join(',')+')' + ';';
		// remap to the typedef
		result.type = result.simpleType = simpleType = blocktypedef;
		result.externTypedef = typedef;
		state.dependencies[simpleType] = result;
	}
	else if (is_function_pointer) {
		var i = type.indexOf('(*)'),
			rt = type.substring(0,i),
			args = type.substring(i+4,type.length-1).split(',').map(function(n){ return n.trim() });

		result.functionPointerArgs = [];
		result.functionPointerReturnType = resolveType(state, rt);

		args.forEach(function(n){
			if (n==='...') {
				result.is_vararg = true;
				return;
			}
			var a = resolveType(state, n);
			result.functionPointerArgs.push(a);
		});

		var fpargs = result.functionPointerArgs.map(function(a){return a.type}),
			fptypedef = 'Function_'+result.mangledName,
			typedef = 'typedef '+result.functionPointerReturnType.type+' (*'+fptypedef+')('+fpargs.join(',')+(result.is_vararg?',...':'')+');';
		// remap to the typedef
		result.type = result.simpleType = simpleType = fptypedef;
		result.externTypedef = typedef;
		state.dependencies[simpleType] = result;
	}
	if (is_struct && typeObject.fields)
	{
		// resolve all field types
		typeObject.fields.forEach(function(field){
			resolveType(state,field.type);
		});
	}

	var imports = [];

	// add the framework for this object
	result.object && result.object.framework && imports.push(result.object.framework);

	// add our state context information
	state.imports[result.type]=imports;
	state.externs[result.type]=[];
	state.typedefs[result.type]=[];

	// if this is an object (meaning we found a type object from the metadata) we are going to attempt to resolve any methods, properties if found
	if (result.is_object) {
		result.object.superClass && (result.superClass = resolveType(state, result.object.superClass));
		result.object.protocols && (result.protocols = []) && result.object.protocols.forEach(function(k){ result.protocols.push(resolveType(state, k)); });
		result.methods = {};
		result.readwrite_properties = {},
		result.readonly_properties = {},
		result.instance_methods = {},
		result.class_methods = {},

		result.object.methods && Object.keys(result.object.methods).forEach(function(name) {
			if (!isSymbolReferenced(state, simpleType, name, 'methods')) {
				return;
			}
			var methods = result.object.methods[name],
				copymethods = [],
				skip = false;

			if (methods.constructor.name!=Array.prototype.constructor.name) {
				var array = [];
				array.push(methods);
				methods = array;
			}

			methods.forEach(function(method) {
				var availability = method.availability || {platform:'ios'};
			    if (availability.message==='Unavailable' || availability.platform!=='ios') {
			        return;
			    }
			    if (method.unavailable) {
			        return;
			    }
			    if (satisfies(availability.deprecated,state.version)) {
			        return;
			    }
				var m = _.clone(method);
				m.returnType = resolveType(state, method.returnType);
				if (method.returnType==='signed char' && method.returnSubtype==='BOOL') {
					m.returnType = resolveType(state, 'bool');					
				}
				var args = [];
				if (method.args && method.args.length) {
					method.args.forEach(function(a) {
						var rt = resolveType(state, a.type);
						if (!rt) {
							// blacklisted, skip the entire method
							skip = true;
							return;
						}
						if (a.type==='signed char' && a.subtype==='BOOL') {
							rt = resolveType(state, 'bool');
						}
						var rtc = _.clone(rt);
						rtc.argument = a;
						args.push(rtc);
					});
				}
				if (!skip) {
					m.args = args;
					if (method.instance) {
						result.instance_methods[name] = method;
					}
					else {
						result.class_methods[name] = method;
					}
					copymethods.push(m);
					// sometimes, methods are added from a category and they are from a different
					// framework than our interface, so we need to add to our imports
					method.framework && imports.indexOf(method.framework)===-1 && imports.push(method.framework);
				}
			});
			if (!skip) {
				result.methods[name] = copymethods;
			}
		});
		result.properties = {};
		result.object.properties && Object.keys(result.object.properties).forEach(function(name) {
			var property = result.object.properties[name],
	            attributes = property.attributes,
            	readonly = attributes && attributes.indexOf('readonly')!=-1,
            	availability = property.availability || {platform:'ios'};
	        if (availability.message==='Unavailable' || availability.platform!=='ios') {
	            return;
	        }
	        if (property.unavailable) {
	            return;
	        }
	        if (satisfies(availability.deprecated,state.version)) {
	            return;
	        }
		    if (!isSymbolReferenced(state, simpleType, name, 'properties')) {
		    	return;
		    }
	        var p = resolveType(state, property.type);
			if (property.type==='signed char' && property.subtype==='BOOL') {
				p = resolveType(state, 'bool');
			}
			//console.error(name,'=>',property);

			if (readonly) {
				result.readonly_properties[name] = p;
			}
			else {
				result.readwrite_properties[name] = p;
			}
			result.properties[name] = p;
		});

		// copy all static Class methods into the class_methods hash
		var sc = result.object.superClass;
		while (sc) {
			sc.methods && Object.keys(sc.methods).forEach(function(name) {
				var methods = sc.methods[name],
					method = methods && methods.length && methods[0];
				if (!method.instance && method) {
					result.class_methods[name] = methods;
					if (method.framework) {
						imports.push(method.framework);
					}
				}
			});
			sc = sc.superClass;
		}

		// sort imports
		state.imports[result.type] = _.uniq(imports);
	}

	return result;
}


/**
 * make a assignment to a variable for an argument
 */
function makeVarAssignmentFromJSValueRef (state, typeobj, arg, name, argname, cleanup) {

	var type = arg.type,
		code = [],
		varassign,
		freevar = 'NULL',
		varname = name,
		varassign = arg.type,
		argobj = resolveType(state,varassign) || arg.type,
		fnname = 'HyperloopJSValueRefTo'+argobj.mangledName;

	varassign = argobj.type;

	if (arg.is_pointer_to_pointer) {
		code.push(varassign+' '+name+'$ = NULL;');
		varname = '&'+name+'$';

		// export our symbol
		var ex = 'Hyperloop'+arg.mangledName+'ToJSValueRef';
		state.externs[typeobj.type].push('extern JSValueRef '+ex+'(JSContextRef,'+varassign+');');

		cleanup.push('JSValueRef '+name+' = '+ex+'(ctx, '+name+'$);');
		cleanup.push('JSObjectRef '+name+'$o = JSValueToObject(ctx,'+argname+',0);');
		cleanup.push('SetJSBufferValue(ctx,'+name+'$o,'+name+');');
	}
	else {

		code.push(varassign+' '+name+' = '+fnname+'(ctx,'+argname+',exception,'+freevar+');');

		// export this symbol
		arg.externTypedef && state.typedefs[typeobj.type].push(arg.externTypedef);

		// export this symbol
		state.externs[typeobj.type].push('extern '+varassign+' '+fnname+'(JSContextRef,JSValueRef,JSValueRef*,bool*);');
	}

	// add framework
	argobj && argobj.object && argobj.object.framework && state.imports[typeobj.type].push(argobj.object.framework);

	return {
		code: code.join('\n'),
		varname: varname,
		is_array: argobj.is_array,
		length: argobj.length
	};
}

/**
 * make a get property body
 */
function makeGetProperty (state, typeobj, property, propertyName, resultName, instanceName) {

	var cleanup = [],
		code = [],
		varname = property.name,
		argname = resultName,
		mangledName = property.mangledName || mangleTypeName(property.type),
		fnname = 'Hyperloop'+mangledName+'ToJSValueRef',
		operator = typeobj.metatype==='struct' ? '->' : '.',
		expression = instanceName + operator + propertyName,
		propobj = resolveType(state,property.type);

	code.push(propobj.type+' '+resultName+'$ = '+expression+';');

	if (propobj.type === 'id') {
		// attempt to dynamically convert from id to our type
		code.push('JSValueRef '+resultName+' = (JSValueRef)[HyperloopConverters convertIDToJSValueRef:'+resultName+'$ withContext:(void*)ctx];');
	}
	else {
		// export this symbol
		property.externTypedef && state.typedefs[typeobj.type].push(property.externTypedef);
		state.externs[typeobj.type].push('extern JSValueRef '+fnname+'(JSContextRef,'+property.type+');');
		code.push('JSValueRef '+resultName+' = '+fnname+'(ctx, '+argname+'$);');
	}

	code.push('return '+resultName+';');

	return code.join('\n');
}

/**
 * make a set property body
 */
function makeSetProperty (state, typeobj, property, propertyName, instanceName, argumentsName, argumentsLengthName) {

	var varassign, 
		operator,
		cleanup = [],
		code = [];

	if (typeobj.metatype==='struct') {
		operator = '->';
		var arg = _.clone(property);
		arg.object = typeobj;
		arg.mangledName = mangleTypeName(property.type);
		varassign = makeVarAssignmentFromJSValueRef(state, typeobj, arg, propertyName+'$'+0, 'value', cleanup);
	}
	else {
		var setter = 'set' + propertyName.charAt(0).toUpperCase() + propertyName.substring(1),
			method = typeobj.methods[setter][0],
			arg = method.args[0];

		operator = '.';
		varassign = makeVarAssignmentFromJSValueRef(state, typeobj, arg, arg.argument.name+'$'+0, 'value', cleanup);
	}

	code.push(varassign.code);
	if (varassign.is_array) {
		for (var c=0;c<varassign.length;c++) {
			code.push(instanceName+operator+propertyName+'['+c+'] = '+varassign.varname+'['+c+'];');
		}
	}
	else {
		code.push(instanceName+operator+propertyName+' = '+varassign.varname+';');
	}

	cleanup.length && (code = code.concat(cleanup));

	return code.join('\n');
}

/**
 * construct a method body
 */
function makeMethod (state, typeobj, methodName, resultName, instanceName, argumentsName, argumentsLengthName) {

	var methods = typeobj.methods[methodName],
		code = [],
		cases;

	if (!methods) {
		// search for method on a subclass
		var sc = typeobj.superClass;
		while (sc) {
			if (methodName in sc.methods) {
				methods = sc.methods[methodName];
				break;
			}
			sc = sc.superClass;
		}
		// if still not found, bail... this shouldn't happen
		if (!methods) {
			console.error("Couldn't find method named: "+methodName+" in "+typeobj.mangledName);
			process.exit(1);
		}
	}	

	if (methods.length > 1) {
		code.push('switch ('+argumentsLengthName+')');
		code.push('{');
		cases = [];
	}

	_.compact(methods).forEach(function(method) {

		var is_instance = method.instance,
			is_void = method.returnType.is_void,
			has_args = method.args.length > 0,
			sel = method.selector.split(':'),
			argbody = [],
			cleanup = [],
			fnbody,
			returnbody;

		//console.error(methodName,'=>',is_void);
		if (methods.length > 1) {
			if (cases.indexOf(method.args.length)!==-1) {
				// this is bad, this means we already have a case statement for this method. we have to drop it for now.
				log.debug('Dropping subsequent case with multiple method types for',typeobj.simpleType,method.name);
				return;
			}
			cases.push(method.args.length);
			code.push(INDENT+'case '+method.args.length+':');
			code.push(INDENT+'{');
		}

		if (is_instance) {
			fnbody = '[' + instanceName+' ' + method.name;
		}
		else {
			if (!method.instance && typeobj.metatype==='protocol') {
				// get the class from the object and use that instead of the normal class name
				fnbody = '[[' + instanceName+' class] ' + method.name;
			}
			else {
				fnbody = '[' + typeobj.simpleType + ' ' + method.name;
			}
		}

		if (has_args) {

			if (method.formatter) {
				code.push(INDENT+INDENT+'id '+resultName+'$$ = HyperloopDynamicInvoke(ctx,'+argumentsName+','+argumentsLengthName+','+instanceName+',@selector('+method.selector+'));');
			}
			else {
				var varassign = makeVarAssignmentFromJSValueRef(state, typeobj, method.args[0], method.args[0].argument.name+'$'+0, argumentsName+'[0]', cleanup);

				argbody.push(varassign.code);
				fnbody += ':'+varassign.varname;

				for (var c=1;c<method.args.length;c++) {
					var va = makeVarAssignmentFromJSValueRef(state, typeobj, method.args[c], method.args[c].argument.name+'$'+c, argumentsName+'['+c+']', cleanup);
					argbody.push(va.code);
					fnbody+=' '+sel[c]+':'+va.varname;
				}
			}
		}

		fnbody = fnbody.trim() + (method.requiresSentinel ? ',nil':'') + '];';

		if (!is_void) {
			if (method.formatter) {
				fnbody = method.returnType.type + ' ' + resultName + '$ = (' +method.returnType.type+') ' + resultName+'$$;';
			}
			else {
				if (method.returnType.is_const) {
					fnbody = method.returnType.type + ' ' + resultName + '$ = (' +method.returnType.type+') ' + fnbody;
				}
				else {
					fnbody = method.returnType.type + ' ' + resultName + '$ = ' + fnbody;
				}
			}
			var fnname = 'Hyperloop'+method.returnType.mangledName+'ToJSValueRef';
			var cast = method.returnType.type;
			returnbody=  'JSValueRef ' + resultName +' = '+fnname+'(ctx,('+cast+')'+resultName+'$);';
			state.externs[typeobj.type].push('extern JSValueRef '+fnname+'(JSContextRef,'+method.returnType.type+');');
			// export this symbol
			method.returnType.externTypedef && state.typedefs[typeobj.type].push(method.returnType.externTypedef);
		}
		else {
			if (method.formatter) {
				fnbody = '';
				code.push('if ('+resultName+'$$){}');
			}
			returnbody = 'JSValueRef ' + resultName + ' = JSValueMakeUndefined(ctx);';
		}


		var indent = methods.length > 1 ? INDENT+INDENT : '';

		argbody.forEach(function(b){
			code.push(indent+b);
		});
		fnbody && code.push(indent+fnbody);
		code.push(indent+returnbody);
		cleanup.length && (code = code.concat(cleanup));
		code.push(indent+'return '+resultName+';');

		if (methods.length > 1) {
			code.push(INDENT+'}');
		}

	});

	if (methods.length > 1) {
		code.push('}');
		code.push('');
		code.push('return JSValueMakeUndefined(ctx);');
	}

	return code.join('\n');
}

/**
 * return interface header contents
 */
function generateInterfaceHeader (state, name) {

	var obj = resolveType(state, name);
	
	// de-dup them
	var externs = _.uniq(state.externs[obj.type]||[]).sort(),
		imports = _.uniq(state.imports[obj.type]||[]).sort(),
		typedefs = _.uniq(state.typedefs[obj.type]||[]).sort();

	name = obj.mangledName;
	
	return ejs.render(header_template, {
		name: name,
		entry: obj.object || {},
		state: state,
		object: obj,
		externs: externs,
		imports: imports,
		typedefs: typedefs,
		extra_includes: (obj.object && obj.object.extra_includes) || []
	});
}

/**
 * return interface contents
 */
function generateInterface (state, name) {

	var obj = resolveType(state, name),
		imports = _.uniq(state.imports[obj.type]||[]).sort();

	name = obj.mangledName;

	return ejs.render(class_template, {
		entry: obj.object || {name:name},
		state: state,
		metadata: state.metadata,
		object: obj,
		instanceName: obj.name,
		name: name,
		filename: mangleTypeName(obj.name),
		varname: name.toLowerCase(),
		readonly_properties: obj.readonly_properties || {},
		readwrite_properties: obj.readwrite_properties || {},
		instance_methods: obj.instance_methods || {},
		class_methods: obj.class_methods || {},
		hasMethodPrototype: hasMethodPrototype,
		makeMethod: makeMethod,
		makeGetProperty: makeGetProperty,
		makeSetProperty: makeSetProperty,
		indentify: indentify,
		imports: imports
	});

}

/**
 * return struct header contents
 */
function generateStructHeader(state, name) {

	var obj = resolveType(state,name),
		instanceName = obj.type,
		// de-dup them
		externs = _.uniq(state.externs[obj.type]||[]).sort(),
		imports = _.uniq(state.imports[obj.type]||[]).sort(),
		typedefs = _.uniq(state.typedefs[obj.type]||[]).sort();

	if (!obj.is_pointer) {
		instanceName+=' *';
	}
	if (obj.framework && imports.indexOf(obj.framework)===-1) {
		imports.push(obj.framework);
	}

	return ejs.render(struct_header_template, {
		state: state,
		entry: obj.object,
		object: obj,
		varname: obj.type.toLowerCase(),
		imports:imports,
		externs: externs,
		typedefs: typedefs,
		instanceName: instanceName,
		name: obj.mangledName,
		makeMethod: makeMethod,
		makeGetProperty: makeGetProperty,
		makeSetProperty: makeSetProperty,
		indentify: indentify
	});
}

/**
 * return struct contents
 */
function generateStruct (state, name) {

	var obj = resolveType(state,name),
		filename = 'js_'+mangleTypeName(name),
		instanceName = obj.type;

	if (!obj.is_pointer) {
		instanceName+=' *';
	}

	return ejs.render(struct_template, {
		state: state,
		entry: obj.object,
		object: obj,
		instanceName: instanceName,
		varname: obj.simpleType.toLowerCase(),
		name: obj.mangledName,
		simpleType: obj.simpleType,
		filename: filename,
		makeMethod: makeMethod,
		makeGetProperty: makeGetProperty,
		makeSetProperty: makeSetProperty,
		indentify: indentify
	});
}

/**
 * return typedefs contents
 */
function generateTypedef (state, name) {

	var obj = resolveType(state,name),
		is_primitive = primitiveTypeRegex.test(obj.object.type);

	return ejs.render(typedef_template, {
		state: state,
		entry: obj.object,
		object: obj,
		instanceName: obj.name,
		varname: obj.type.toLowerCase(),
		simpleType: obj.simpleType,
		name: obj.mangledName,
		makeMethod: makeMethod,
		makeGetProperty: makeGetProperty,
		makeSetProperty: makeSetProperty,
		indentify: indentify
	});
}

/**
 * return typedefs header contents
 */
function generateTypedefHeader(state, name) {

	var obj = resolveType(state,name),
		// de-dup them
		externs = _.uniq(state.externs[obj.type]||[]).sort(),
		imports = _.uniq(state.imports[obj.type]||[]).sort(),
		typedefs = _.uniq(state.typedefs[obj.type]||[]).sort();

	return ejs.render(typedef_header_template, {
		state: state,
		entry: obj.object,
		object: obj,
		name: obj.mangledName,
		varname: obj.type.toLowerCase(),
		instanceName: obj.name,
		imports:imports,
		externs: externs,
		typedefs: typedefs
	});
}

/**
 * return a suitable default value
 */
function defaultValue(obj) {
	if (obj.is_char_array) return "NULL";
	if (obj.simpleType=='char') return "'\\0'";
	if (obj.is_primitive) return "0";
	return "NULL";
}

/**
 * return primitive code
 */
function generatePrimitive (state, name) {

	var obj = resolveType(state,name),
		varType = obj.type + ' result',
		returnType = obj.type,
		typeName = name,
		imports = _.uniq(state.imports[obj.type]||[]).sort();

	if (obj.is_const) {
		returnType = obj.type.replace('const ','').trim();
		varType = returnType + ' result';
	}

	if (obj.object && obj.object.type) {
		typeName = obj.object.type;
	}


	return ejs.render(type_to_native_template, {
		state: state,
		typeName: typeName,
		name: obj.mangledName,
		typeObject: obj,
		instanceName: obj.name,
		variableName: 'object',
		resultName: 'result',
		isArray: obj.is_array,
		isPointer: obj.is_pointer,
		isPointerToPointer: obj.is_pointer_to_pointer,
		returnType: returnType,
		varType: varType,
		type: obj.type,
		simpleType: obj.simpleType,
		length: obj.length,
		isCharArray: obj.is_char_array,
		defaultValue: defaultValue(obj),
		imports: imports
	});
}

/**
 * generate the interface converters file contents
 */
function generateInterfaceConverters (state, interfaces, filename) {
	var imports = ['Foundation','JavaScriptCore'],
		intf = {};
	function sortNameFunction(a,b) {
		if (a.name===b.name) return 0;
		if (a.name < b.name) return -1;
		return 1;
	}
	interfaces.sort(sortNameFunction).forEach(function(entry) {
		var framework = entry && entry.object && entry.object.framework;
		if (!framework) {
			console.error("Couldn't find framework for interface:",entry.name);
			process.exit(1);
		}
		imports.push(framework);
		if (!(entry.name in intf)) {
			intf[entry.name] = entry;
		} 
	});
	return ejs.render(interface_to_native_class_template,{
		state:state,
		filename:filename,
		interfaces: _.values(intf),
		imports: _.uniq(imports)
	});
}

/**
 * generate the interface converters header file contents
 */
function generateInterfaceConvertersHeader (state) {
	return interface_to_native_class_header_template;
}

function compile (metadata, config, callback) {

	var version = config.version,
		types = config.types || ['UIApplication'],
		builddir = config.builddir,
		outdir = config.outdir || builddir,
		state = createState(metadata,version);

	types.forEach(function(type){
		resolveType(state, type);
	});

	if (!fs.existsSync(outdir)) {
		wrench.mkdirSyncRecursive(outdir);
	}

	var sources = [],
		interfaces = [];

	_.compact(Object.keys(state.dependencies).sort()).forEach(function(symbolName) {
		var obj = state.dependencies[symbolName];
		switch (obj.metatype) {
			case 'interface': {
				interfaces.push(obj);
				// let it fall through
			}
			case 'protocol': {
				var className = obj.name,
					fn = 'js_'+mangleTypeName(className),
					framework = (obj && obj.object && obj.object.framework) || 'Foundation',
					fp = path.join(outdir, 'js_'+framework, fn),
					source = fp+'.m',
					header = fp+'.h';
				if (sources.indexOf(source)===-1) {
					if (!fs.existsSync(path.dirname(fp))) {
						wrench.mkdirSyncRecursive(path.dirname(fp));
					}
					fs.writeFileSync(source,generateInterface(state,className));
					fs.writeFileSync(header,generateInterfaceHeader(state,className));
					sources.push(source);
				}
				break;
			}
			case 'block': {
				// console.error('BLOCK NOT HANDLED=',obj.object);
				break;
			}
			case 'function_pointer': {
				// console.error('FUNCTION POINTER NOT HANDLED=',obj.object);
				break;
			}
			case 'primitive': {
				var simpleType = 'js_'+mangleTypeName(symbolName),
					fp = path.join(outdir,simpleType),
					source = fp+'.m';
				if (sources.indexOf(source)===-1) {
					if (!fs.existsSync(path.dirname(fp))) {
						wrench.mkdirSyncRecursive(path.dirname(fp));
					}
					fs.writeFileSync(source,generatePrimitive(state,symbolName));
					sources.push(source);
					// console.error('primitive',source)
				}
				break;
			}
			case 'struct': {
				var simpleType = 'js_'+mangleTypeName(symbolName),
					fn = (obj && obj.object && obj.object.framework ? 'js_'+obj.object.framework+'/' : '') + simpleType,
					fp = path.join(outdir,fn),
					source = fp+'.m',
					header = fp+'.h';
				if (sources.indexOf(source)===-1) {
					if (!fs.existsSync(path.dirname(fp))) {
						wrench.mkdirSyncRecursive(path.dirname(fp));
					}
					fs.writeFileSync(source,generateStruct(state,symbolName));
					fs.writeFileSync(header,generateStructHeader(state,symbolName));
					sources.push(source);
					// console.error('struct',source)
				}
				break;
			}
			case 'enum': {
				break;
			}
			case 'typedef': {
				var className = obj.name,
					fn = 'js_'+mangleTypeName(className),
					fn = (obj && obj.object && obj.object.framework ? 'js_'+obj.object.framework+'/' : '') + fn,
					fp = path.join(outdir, fn),
					source = fp+'.m',
					header = fp+'.h';
				if (sources.indexOf(source)===-1) {
					if (!fs.existsSync(path.dirname(fp))) {
						wrench.mkdirSyncRecursive(path.dirname(fp));
					}
					fs.writeFileSync(source,generateTypedef(state,symbolName));
					fs.writeFileSync(header,generateTypedefHeader(state,symbolName));
					sources.push(source);
					// console.error('typedef',source)
				}		
				break;
			}
			case 'other': {
				if (obj.is_void) {
					//TODO
				}
				else {
					console.error("I don't know how to handle",obj);
					process.exit(1);
				}
				break;
			}
			default: {
				console.error(obj);
				process.exit(1);
			}
		}
	});

	// now do convertors code
	var fp = path.join(outdir, CLASS_CONVERTER_FILENAME.replace('.h','').trim());
	fs.writeFileSync(fp+'.m', generateInterfaceConverters(state, interfaces, CLASS_CONVERTER_FILENAME));
	fs.writeFileSync(fp+'.h', generateInterfaceConvertersHeader(state, interfaces));
	sources.push(fp+'.m');


	var includedir = path.join(__dirname,'templates','source');

	sources.push(path.join(includedir,'hyperloop.m'));
	sources.push(path.join(includedir,'JSBuffer.m'));

	var buildlib = require('../buildlib');
	var config = {
		minVersion: version,
		libname: config.libname || 'libapp.a',
		srcfiles: sources,
		outdir: builddir,
		cflags: ['-I'+includedir,'-I'+outdir],
		linkflags: [],
		no_arc: true,
		debug: config.debug
	};

	buildlib.compileAndMakeStaticLib(config, callback);
}

if (module.id===".") {
	var json = "/Users/jhaynie/Library/Application Support/org.appcelerator.hyperloop/cache/bbf2d450bac4ef5e4c37c2fc264c7e23.json",
		metadata = JSON.parse(fs.readFileSync(json).toString()),
		builddir = path.join(__dirname,'..','..','..','build'),
		outdir = path.join(builddir,'source');

	log.debugLevel = true;

	var config = {
		version: '7.0',
		types: ['UIView'],
		builddir: builddir,
		outdir: outdir
	};

	compile(metadata, config, function(err,results){
		err && console.error(err) && process.exit(1);
		console.log(results);
	});

}