const Fs = require('fs');
const Path = require('path');

const ROUTES_PATH = PATH.root(CONF.ar.src ? CONF.ar.src : 'routes');
const SSR_ENABLED = CONF.ar.ssr || false;
const DEFAULT_FORM = CONF.ar.default_form || 'form';
const AUTH_PATH = `${ROUTES_PATH}/auth.js`;
const SERVER_HOOKS_PATH = `${ROUTES_PATH}/hooks.server.js`;
const CLIENT_HOOKS_PATH = `${ROUTES_PATH}/hooks.client.js`;
const APP_HTML_PATH = `${ROUTES_PATH}/app.html`;
const LAYOUT_HTML_PATH = `${ROUTES_PATH}/layout.html`;
const DEFAULT_ROUTER = CONF.ar.use || 'default';
const API_PATH = CONF.ar.api || '/api/';
const WS_PATH = CONF.ar.ws || '/';
const REG_ROUTES = /GET|POST|PATCH|PUT|DELETE|FILE|SOCKET/;
const REG_ROUTES_ALLOWED_PATH = /FILE/;
const REG_SLASH = /^\/|\/$/g;
const REG_FORM_FILENAME = /form(.*)\.html|(.*).form.html/;
const REG_ROUTER_DIV = /<router\s?\S?>/;
const REG_PARAM = /\{.*?\}/g;
const REG_UICOMPONENT = /<ui-component(.+?)name=\s*"([^"]*?)"/g;
const REG_SPECIAL_CHARS = /\W/g;
const REG_FORMNAME = /[^\/\\&\?]+\.\w{3,4}(?=([\?&].*$|$))/;
const REG_PAGE_CONFIG = /(Page\.config)\s*\S*\s*(\{.*?\})(\s*;|;)/s;
const REG_FORM_CONFIG = /(Form\.config)\s*\S*\s*(\{.*?\})(\s*;|;)/s;
const REG_DOT = /\./g;
const REG_START_SCRIPT = /<script>/g;
const REG_END_SCRIPT = /<\/script>/g;
const REG_SCRIPT = /<script[^>]*[^>]*>[^~]*?<\/script>/g;
const PREFIX_PAGE = 'p';
const PREFIX_LAYOUT = 'l';
const PREFIX_FORM = 'f';

const PAGE_ID = (binding) => PREFIX_PAGE + binding.replace(REG_DOT, '');

const DEFAULT_ACTION = function() {
	var self = this;
	self.json({ error: 'MISSING `action` FOR THIS ROUTE!', params: self.params, q: self.query });
}

var uicom = CONF.ar.components ? CONF.ar.components.split(',') : [];
uicom.push('importer,exec');
var pages = [];
var isauth = false;
var ishook = false;

function read_config(content, isform) {
	extract_components(content);
	try {
		var config = content.match(isform ? REG_FORM_CONFIG : REG_PAGE_CONFIG)[2];
		var str = JSON.stringify(eval('(' + config + ')'));
		return JSON.parse(str);
	} catch (e) {
		return '';
	}
}

function extract_components(html) {
	var com = html.match(REG_UICOMPONENT);
	if (com) {
		com.map(function(val, i) {
			var tmp = val.match(/name="(.*)"/)[1] || '';
			tmp = tmp.replace('LAZY', '').trim();
			com[i] = tmp;
		});
		uicom.push(...com);
	}
}

function insert_plugin(content, name, isform) {

	var index = match_script(content, isform);
	if (index.start) {
		index.start += 8;
		content = `${content.slice(0, index.start)}\nPLUGIN('${name}', function(${isform ? 'Form' : 'Page'}) {\n${isform ? 'Form.open' : 'Page.open'} = ar.open;${isform ? 'Form.data' : 'Page.data'} = ar.data;${isform ? 'Form.api' : 'Page.api'} = ar.api;\n${content.slice(index.start)}`;

		index = match_script(content, isform);
		index.end -= 9;
		content = `${content.slice(0, index.end)}\n});\n${content.slice(index.end)}`;
	}

	return content;
}

function match_script(content, isform) {
	var re = new RegExp(REG_SCRIPT);
	var obj = {};
	var match;

	while (match = re.exec(content)) {
		if (match[0].indexOf(isform ? 'Form' : 'Page') !== -1) {
			obj.start = match.index;
			obj.end = re.lastIndex;
		}
	}

	return obj;
}

// Read folders and map to array
function readfolders(dir, layout) {

	var content = Fs.readdirSync(dir);

	var route = {};
	route.path = dir;
	route.url = route.path.replace(ROUTES_PATH, '').replace(/\+/g, '');
	route.url = route.url ? route.url : '/';
	route.isprotected = route.path.indexOf('+') !== -1;
	route.forms = [];
	route.routes = [];
	route.layout = route.page = route.server = null;

	// Map all files
	for (var i = 0; i < content.length; i++) {
		var name = Path.join(dir, content[i]);
		if (!Fs.statSync(name).isDirectory() && route.url) {
			if (name.indexOf('/layout.html') !== -1)
				route.layout = name;
			if (name.indexOf('/page.html') !== -1)
				route.page = name;
			if (name.indexOf('/server.js') !== -1)
				route.server = name;
			if (REG_FORM_FILENAME.test(name))
				route.forms.push(name);
		}
	}

	if (!route.layout)
		route.layout = layout;

	// Map all children
	for (var i = 0; i < content.length; i++) {
		var name = Path.join(dir, content[i]);
		if (Fs.statSync(name).isDirectory())
			route.routes.push(readfolders(name, route.layout));
	}

	return route;
}

function parseroute(routes) {

	if (!routes.length) {
		makeserver();
		return;
	}

	var route = routes.pop();
	routes.push(...route.routes);
	delete route.routes;

	route.binding = route.url.replace(/{|}/g, '').split('/').trim().join('.');
	route.binding = route.binding ? route.binding : 'root';
	route.schema = route.binding.replace(REG_DOT, '_');

	var dynamic = route.url.split('/');
	var i = 1;
	if (dynamic && dynamic.length > 1) {
		dynamic.filter(function(val, index) {
			if (dynamic.indexOf(val) !== index)
				dynamic[index] = val.replace(/\}$/, `${i++}}`);
		});
	}
	route.url = dynamic.join('/');

	var match = route.url.match(REG_PARAM);
	route.api = route.url.replace(REG_PARAM, '').replace(/\/$|^\//g, '').replace(/\/\//g, '_').replace(/\//g, '_');
	route.api = `${route.api}__%action%${match ? ('/' + match.join('/')) : ''}`;
	pages.push(route);

	parseroute(routes);
}

async function makeserver() {

	if (DEFAULT_ROUTER === 'ws')
		ROUTE(`SOCKET ${WS_PATH} @api`);

	var servers = pages.filter(m => !!m.server);
	for (var i = 0; i < servers.length; i++) {

		var server = servers[i];
		server.actions = [];

		var routes = require(server.server);
		for (var [key, value] of Object.entries(routes))
			server.actions.push(prepareroute(key, value, server));
	}

	var routedata = await prepare_routedata();

	// Register all server routes and schemas
	startroutes();

	var clientdata = {};
	clientdata.ssr = SSR_ENABLED;
	clientdata.api = API_PATH;
	clientdata.ws = WS_PATH;
	clientdata.router = DEFAULT_ROUTER;
	clientdata.navigation = routedata.navigation;
	clientdata.forms = routedata.forms;
	clientdata.actions = [];
	var actions = pages.filter(m => !!m.actions);
	for (var i = 0; i< actions.length; i++) {
		var route = actions[i];
		for (var j = 0; j < route.actions.length; j++) {
			var action = route.actions[j];
			var m = {};
			m.id = `${route.binding}.${action.name}`;
			m.pageid = PAGE_ID(route.binding);
			m.api = route.api;
			m.name = action.name;
			m.type = action.type;
			m.method = action.method;
			m.path = action.path;
			clientdata.actions.push(m);
		}
	}

	Fs.rmSync(PATH.public('dist'), { recursive: true, force: true });
	Fs.mkdirSync(PATH.public('dist'));
	Fs.mkdirSync(PATH.public('dist/pages'));
	Fs.mkdirSync(PATH.public('dist/forms'));

	Fs.rmSync(PATH.views(), { recursive: true, force: true });
	Fs.mkdirSync(PATH.views());

	var appjs = [];
	var hooks = '';

	try {
		hooks = await Fs.promises.readFile(CLIENT_HOOKS_PATH, 'utf-8');
	} catch(e) {}

	var clientjs = await Fs.promises.readFile(Path.resolve(__dirname, 'client.js'), 'utf-8');
	clientjs = clientjs.replace('%%CONFIG%%', JSON.stringify(clientdata));

	appjs.push(clientjs);
	if (!SSR_ENABLED)
		appjs.push(`(function(){${routedata.router}})();`);
	appjs.push(`(function(){${hooks}})();`);

	var app = await Fs.promises.readFile(APP_HTML_PATH, 'utf-8');
	var match = app.match(/<\/body>/gi);
	var index = app.indexOf(match[0]);
	app = `${app.slice(0, index)}<script type="application/json" id="ardata">@{json(repository)}</script><script type="application/json" id="aruser">@{json(user)}</script><script src="/dist/app.js"></script>${app.slice(index)}`;

	var builder = [];
	if (CONF.ar.cdn !== false)
		builder.push('<script src="//cdn.componentator.com/spa.min@19.js"></script><link href="//cdn.componentator.com/spa.min@19.css" rel="stylesheet" />');

	if (CONF.ar.cdn_auto !== false)
		builder.push('<script src="@{REPO.ui}"></script>');

	var match = app.match(/<\/head>/gi);
	var index = app.indexOf(match[0]);
	app = `${app.slice(0, index)}${builder.join('')}${app.slice(index)}`;

	if (!SSR_ENABLED)
		app = app.replace('%total4.body%', routedata.appcontent);

	extract_components(app);

	if (!SSR_ENABLED)
		await Fs.promises.writeFile(PATH.views('index.html'), U.minify_html(app));
	await Fs.promises.writeFile(PATH.public('dist/app.js'), U.minify_js(appjs.join('')));

	for (var i = 0; i < routedata.layouts.length; i++) {
		var layout = routedata.layouts[i];

		build_layout_file(layout, SSR_ENABLED ? CLONE(app) : null);

		for (var j = 0; j < layout.pages.length; j++) {
			var page = layout.pages[j];
			build_page_file(page, layout.id);

			for (var k = 0; k < page.forms.length; k++)
				build_form_file(page.forms[k]);
		}
	}

	if (uicom.length && CONF.ar.cdn_auto !== false) {
		uicom = [...new Set(uicom)];
		COMPONENTATOR('ui', uicom.join(','), true);
	}
}

async function build_layout_file(layout, app) {
	var content = await Fs.promises.readFile(layout.file, 'utf-8');
	content = content.replace(REG_ROUTER_DIV, layout.content);
	content = insert_plugin(content, layout.id);

	if (SSR_ENABLED) {
		app = app.replace('%total4.body%', content);
		await Fs.promises.writeFile(PATH.views(`${layout.id}.html`), U.minify_html(app));
	} else
		await Fs.promises.writeFile(PATH.public(`dist/${layout.id}.html`), U.minify_html(content));
}

async function build_page_file(page, layoutid) {
	var content = await Fs.promises.readFile(page.file, 'utf-8');
	content = insert_plugin(content, page.id);

	var index = content.length;
	content = `${content.slice(0, index)}\n${page.content.join('')}${content.slice(index)}`;

	if (SSR_ENABLED) {
		content = `@{layout('${layoutid}')}${content}`;
		await Fs.promises.writeFile(PATH.views(`${page.id}.html`), U.minify_html(content));
	}
	else
		await Fs.promises.writeFile(PATH.public(`dist/pages/${page.id}.html`), U.minify_html(content));
}

async function build_form_file(form) {
	uicom.push(form.type);

	var content = await Fs.promises.readFile(form.file, 'utf-8');

	var index = match_script(content, true);
	var tmp = `<ui-component name="${form.type}" plugin="${form.id}" path="${form.path}" config="${form.config}" class="hidden">`;
	tmp += content.substr(0, index.start) + content.substr(index.end, content.length) + '</ui-component>';
	tmp += content.substr(index.start, index.end);
	tmp = insert_plugin(tmp, form.id, true);

	await Fs.promises.writeFile(PATH.public(`dist/forms/${form.id}.html`), tmp);
}

async function prepare_routedata(layouts) {

	var layouts = [];
	var clientforms = [];

	// Prepare layouts
	var arr = pages.filter((value, index, self) => self.map(x => x.layout).indexOf(value.layout) == index);
	for (var i = 0; i < arr.length; i++) {
		var route = arr[i];
		var layout = {};
		layout.id = route.layout === LAYOUT_HTML_PATH ? 'main' : route.layout.crc32().toString().md5().slug(5);
		layout.id = PREFIX_LAYOUT + layout.id;
		layout.file = route.layout;
		layout.pages = [];
		layout.content = SSR_ENABLED ? '@{body}' : [];
		layout.paths = [];

		// Config
		var content = await Fs.promises.readFile(layout.file, 'utf-8');
		var config = read_config(content);
		layout.default_form = config.default_form || DEFAULT_FORM;
		layout.title = config.title || '';
		// /Config

		layouts.push(layout);
	}

	// Prepare pages
	var arr = pages.filter(m => !!m.page);
	for (var i = 0; i < arr.length; i++) {
		var route = arr[i];
		var page = {};
		page.id = PAGE_ID(route.binding);
		page.url = route.url;
		page.file = route.page;
		page.auth = route.isprotected;
		page.forms = [];
		page.content = [];

		var layout = layouts.findItem('file', route.layout);

		// Config
		var content = await Fs.promises.readFile(page.file, 'utf-8');
		var config = read_config(content);
		page.title = config.title || layout.title;
		page.navtitle = config.navtitle || '';
		page.default_form = config.default_form || layout.default_form;
		// /Config

		layout.paths.push(page.id);
		layout.pages.push(page);

		if (!SSR_ENABLED)
			layout.content.push(`<ui-component name="page" plugin="${page.id}" path="ar.page" config="if:${page.id};url:/dist/pages/${page.id}.html;reload:${page.id}/reload"></ui-component>`);

		for (var j = 0; j < route.forms.length; j++) {
			var file = route.forms[j];
			var form = {};
			form.file = file;
			form.id = file.match(REG_FORMNAME, '')[0];

			if (form.id.indexOf('.form.html') !== -1)
				form.id = form.id.replace('.form.html', '');
			else
				form.id = form.id.replace('form', page.id.substring(1)).replace('.html', '');

			form.level = form.id.split('@')[1] || 0;
			form.level = parseInt(form.level);
			form.name = form.id.replace(REG_SPECIAL_CHARS, '');
			form.id = PREFIX_FORM + form.name + GUID(3);
			form.path = 'ar.form' + (form.level > 0 ? form.level : '');

			// Config
			var content = await Fs.promises.readFile(form.file, 'utf-8');
			var config = read_config(content, true);
			form.type = config.type || page.default_form;
			form.config = config.config || '';
			form.config = config_ignore(form.config);
			form.config = `if:${form.id};reload:${form.id}/reload;submit:${form.id}/submit;cancel:${form.id}/cancel${form.config.startsWith(';') ? form.config : ';' + form.config}`;
			form.path = config.custom_path || form.path;
			// /Config

			clientforms.push({ type: form.type, id: form.id, name: form.name, level: form.level, pageid: page.id, path: form.path, find: `${page.id.substring(1)}.${form.name}` });
			page.content.push(`<div data---="importer__${form.path}__if:${form.id};url:/dist/forms/${form.id}.html"></div>`);
			page.forms.push(form);
		}
	}

	var appcontent = []; // layouts_component
	var routes = []; // router
	var navigation = []; // navigation

	for (var i = 0; i < layouts.length; i++) {
		var layout = layouts[i];

		if (!SSR_ENABLED)
			layout.content = layout.content.join('');

		if (layout.paths.length && !SSR_ENABLED)
			appcontent.push(`<ui-component name="page" path="ar.page" config="if:${layout.paths.join(',')};url:/dist/${layout.id}.html;reload:${layout.id}/reload"></ui-component>`);

		for (var j = 0; j < layout.pages.length; j++) {
			var page = layout.pages[j];

			var builder = [];
			if (page.title)
				builder.push(`SETTER(true, 'title/rename', '${page.title}');`);
			builder.push(`SET('ar.layout', '${layout.id}');`);
			builder.push(`SET('ar.page', '${page.id}');`);

			if (SSR_ENABLED) {
				ROUTE(`${page.auth ? '+' : ''}GET ${page.url}`, page.id, [ishook ? '&ar_hook' : '']);
			} else
				routes.push(`ROUTE('${page.url}', function() { ${builder.join('')} }${page.auth ? ', \'authorized\'' : ''});`);
			navigation.push({ id: page.id, navtitle: page.navtitle, title: page.title, url: page.url, auth: page.auth, hasparam: REG_PARAM.test(page.url) });
		}
	}

	return { appcontent: appcontent.join(''), router: routes.join(''), navigation: navigation, layouts: layouts, forms: clientforms };
}

function config_ignore(config) {

	if (!config)
		return '';

	var builder = [];
	var ignored = ['if', 'reload', 'submit', 'cancel'];

	try {
		var attr = config.split(';');
		for (var i = 0; i < attr.length; i++) {
			var val = attr[i].split(':');
			if (ignored.indexOf(val[0]) === -1)
				builder.push(attr[i]);
		}
		return builder.join(';');
	} catch(e) {
		return '';
	}

}

function prepareroute(name, value, route) {

	var obj = {};
	obj.name = name.toLowerCase();
	obj.type = DEFAULT_ROUTER;
	obj.method = '';
	obj.path = route.url;
	obj.action = value.action ? value.action : DEFAULT_ACTION;
	obj.flags = [];
	obj.next = '';
	obj.length = null;
	obj.isprotected = route.isprotected;
	obj.validation = true;
	obj.isroute = true;
	obj.isschema = value.action ? true : false;

	if (value.ar) {

		if (value.ar.type)
			obj.type = value.ar.type;

		if (value.ar.router === false)
			obj.isroute = false;

		if (value.ar.schema === false)
			obj.isschema = false;

		if (value.ar.flags)
			obj.flags = value.ar.flags;

		if (value.ar.length)
			obj.length = value.ar.length;

		if (value.ar.method)
			obj.method = value.ar.method.toUpperCase();

		if (value.ar.path && REG_ROUTES_ALLOWED_PATH.test(value.ar.method))
			obj.path = `/${value.ar.path.replace(REG_SLASH, '')}`;

		if (value.ar.next)
			obj.next = ' ' + value.ar.next;

		if (value.ar.validation === false)
			obj.validation = false;
	}

	if (REG_ROUTES.test(name)) {
		obj.method = name;
		obj.isroute = !(name === 'GET' && route.page);
		obj.type = 'default';
		return obj;
	}

	// Default route
	if (obj.type === 'default') {
		obj.method = obj.method || 'GET';
		obj.path = `${obj.path}/_${name}`;
		return obj;
	}

	// API and WS API routes
	obj.path = `${obj.validation ? '+' : '-'}${route.api.replace('%action%', name)}`;
	return obj;
}

function startroutes() {

	// @todo: Start new WS server if needed
	var servers = pages.filter(m => m.actions && m.actions.length);

	for (var i = 0; i < servers.length; i++) {
		var route = servers[i];

		// Register schema
		NEWSCHEMA(route.schema, function(schema) {
			for (var j = 0; j < route.actions.length; j++) {
				var action = route.actions[j];
				if (action.isschema)
					schema.action(action.name, action);
			}
		});

		// Register route
		for (var j = 0; j < route.actions.length; j++) {
			var action = route.actions[j];

			if (!action.isroute)
				continue;

			var schema = action.isschema ? ` *${route.schema} --> ${action.name}${action.next}` : null;

			if (!schema && (action.type === 'ws' || action.type === 'api')) {
				console.log('IGNORED ', action.path, ' (API routes must be used with schema)');
				continue;
			}

			if (schema) {
				var apipath = action.type === 'ws' ? '@api' : (action.type === 'api' ? API_PATH : '');
				ROUTE(`${action.isprotected ? '+' : ''}${action.type === 'default' ? action.method : 'API'} ${apipath} ${action.path}${schema}`, action.flags || null, action.length || null);
			} else
				ROUTE(`${action.isprotected ? '+' : ''}${action.method} ${action.path}`, action.action, action.flags || null, action.length || null);
		}
	}

}

function init() {
	var root = readfolders(ROUTES_PATH, LAYOUT_HTML_PATH);

	try {
		var authopt = require(AUTH_PATH);
		AUTH(authopt);
		isauth = true;
	} catch {}

	try {
		var hook = require(SERVER_HOOKS_PATH);
		NEWMIDDLEWARE('ar_hook', hook);
		ishook = true;
	} catch {}

	if (!SSR_ENABLED) {
		ROUTE('GET /*', function() {
			this.layout('');
			this.view('index');
		}, [ishook ? '&ar_hook' : '']);
	}

	parseroute([root]);
}

module.exports = {
	init
};