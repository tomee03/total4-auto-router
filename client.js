(function(){

	MIDDLEWARE('authorized', function(next) {
	    next(ar.user ? true : false);
	});

	var ar = window.ar = {};
	ar.layout = '';
	ar.page = '';
	ar.form = '';
	ar.data = {};

	var config = JSON.parse('%%CONFIG%%');

	ar.navigation = config.navigation;

	if (!config.ssr)
		NAV.clientside('a:not(.external)');

	if (config.router === 'ws')
		WAPI({ url: config.ws });

	try {
		ar.user = JSON.parse($('#aruser').html());
		$('#aruser').remove();
	} catch(e) {}

	try {
		ar.data = JSON.parse($('#ardata').html());
		$('#ardata').remove();
	} catch(e) {}

	ar.api = function(path, data, callback, delay) {

		var action;
		var qsplit = path.split('?');
		var q = qsplit.length > 1 ? `?${qsplit[1]}` : '';
		path = qsplit.length > 1 ? qsplit[0] : path;

		var args = path.split('/');
		path = args.length > 1 ? args[0] : path;

		if (path[0] === '!')
			action = config.actions.findItem('id', path.replace(/^./, ''));
		else {
			var actions = config.actions.findAll('pageid', ar.page);
			action = actions.findItem('name', path);
		}

		if (!action) {
			console.log(`Requested path "${path}" not found!`);
			return;
		}

		if (action.type === 'default') {
			var split = action.path.split('/');
			var argsindex = 1;

			for (var i = 0; i < split.length; i++) {
				if (split[i].indexOf('{') !== -1) {
					split[i] = args[argsindex];
					argsindex++;
				}
			}

			AJAX(`${action.method} ${split.join('/')}${q}`, data, callback, delay);
			return;
		}

		var url = action.api.replace('%action%', action.name);

		var split = url.split('/');

		if (split.length > 1) {
			split.filter(function(val, index) {
				if (index)
					split[index] = args[index];
			});
		}

		if (config.router === 'api')
			API(`${config.api} ${split.join('/') + q}`, data, callback);
		else
			WAPI(split.join('/'), data, callback);
	};

	ar.open = function(name, data) {

		if (name[0] === '!') {
			name = name.substring(1);
			var split = name.split(' ');
			var form = config.forms.findItem('find', split.length > 1 ? split[0] : name);
			SET((split.length > 1 ? `${form.path} ${split[1]}` : form.path), form.id);
		} else {
			var form = config.forms.findItem('find', `${ar.page.substring(1)}.${name}`);
			SET(form.path, form.id);
			if (data)
				SET(form.id, data);
		}
	};

})();