var DMV_GITHUB_REPOS_PER_CHUNK = 10;

function dmvGithubFields_() {
  return [
    { key: 'repo_url', label: 'Repository URL', type: 'text', role: 'dimension', default: true },
    { key: 'full_name', label: 'Repository', type: 'text', role: 'dimension', default: true },
    { key: 'description', label: 'Description', type: 'text', role: 'dimension', default: true },
    { key: 'language', label: 'Language', type: 'text', role: 'dimension', default: true },
    { key: 'stargazers_count', label: 'Stars', type: 'number', role: 'metric', default: true },
    { key: 'forks_count', label: 'Forks', type: 'number', role: 'metric', default: true },
    {
      key: 'open_issues_count',
      label: 'Open issues and pull requests',
      type: 'number',
      role: 'metric',
      default: true,
    },
    { key: 'created_at', label: 'Created at', type: 'date', role: 'dimension', default: false },
    { key: 'pushed_at', label: 'Last push', type: 'date', role: 'dimension', default: true },
    { key: 'archived', label: 'Archived', type: 'text', role: 'dimension', default: false },
    { key: 'private', label: 'Private', type: 'text', role: 'dimension', default: false },
    { key: 'license', label: 'License', type: 'text', role: 'dimension', default: false },
  ];
}

function dmvGithubHeaders_(credentials) {
  var headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (credentials.token) headers.Authorization = 'Bearer ' + credentials.token;
  return headers;
}

function dmvGithubFetch_(ctx) {
  return dmvFetchChunks_(ctx, dmvGithubFetchChunk_);
}

function dmvGithubFetchChunk_(ctx, state) {
  var columns = dmvSelectFields_(ctx.fields, dmvGithubFields_());
  var list = String(ctx.config.repositories || '').trim();
  var query = String(ctx.config.query || '').trim();
  var headers = dmvGithubHeaders_(ctx.credentials);
  var records = [];
  var nextState = null;
  if (list) {
    var seen = {};
    var names = list
      .split(/[\n,]+/)
      .map(function (item) {
        var raw = item.trim();
        if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(raw)) raw = 'https://github.com/' + raw;
        var match =
          /^https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(?:[/?#].*)?$/i.exec(
            raw
          );
        if (!match) throw new Error('Enter repository URLs or owner/repository names.');
        return match[1] + '/' + match[2].replace(/\.git$/i, '');
      })
      .filter(function (name) {
        if (seen[name.toLowerCase()]) return false;
        seen[name.toLowerCase()] = true;
        return true;
      });
    if (names.length > Math.min(50, ctx.maxRows))
      throw new Error('Use at most 50 repositories and keep within the row limit.');
    var index = state ? state.index : 0;
    if (
      (state && state.mode !== 'list') ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= names.length
    )
      throw new Error('GitHub repository continuation is invalid. Run the report again.');
    // Several small repository reads fit one chunk comfortably; the deadline check guards each.
    var end = Math.min(names.length, index + DMV_GITHUB_REPOS_PER_CHUNK);
    for (var position = index; position < end; position++) {
      ctx.checkDeadline();
      records.push(
        ctx.http({ url: 'https://api.github.com/repos/' + names[position], headers: headers })
      );
    }
    if (end < names.length) nextState = { mode: 'list', index: end };
  } else {
    if (!query) throw new Error('Enter a GitHub search or a repository list.');
    if (
      state &&
      (state.mode !== 'search' ||
        !Number.isInteger(state.page) ||
        state.page < 2 ||
        !Number.isInteger(state.total) ||
        state.total < 1 ||
        !Number.isInteger(state.count) ||
        state.count < 1 ||
        state.count >= state.total ||
        !Array.isArray(state.ids) ||
        !Array.isArray(state.names) ||
        state.ids.length !== state.count ||
        state.names.length !== state.count)
    )
      throw new Error('GitHub search continuation is invalid. Run the report again.');
    var page = state ? state.page : 1,
      total = state ? state.total : null,
      count = state ? state.count : 0,
      resultIds = state ? state.ids.slice() : [],
      resultNames = state ? state.names.slice() : [];
    ctx.checkDeadline();
    var response = ctx.http({
      url:
        'https://api.github.com/search/repositories?q=' +
        encodeURIComponent(query) +
        '&sort=stars&per_page=100&page=' +
        page,
      headers: headers,
    });
    if (response.incomplete_results)
      throw new Error(
        'GitHub returned incomplete search results. Narrow the search and try again.'
      );
    if (
      !Array.isArray(response.items) ||
      !Number.isInteger(response.total_count) ||
      response.total_count < 0
    )
      throw new Error('GitHub returned an invalid search page.');
    if (total === null) total = response.total_count;
    else if (total !== response.total_count)
      throw new Error('GitHub search changed during pagination. Run it again.');
    if (total > Math.min(ctx.maxRows, 1000))
      throw new Error(
        "The search exceeds the row limit or GitHub's 1,000-result cap. Narrow the search."
      );
    if (!response.items.length && count < total)
      throw new Error('GitHub search ended before all results arrived. Try again.');
    response.items.forEach(function (item) {
      if (
        !item ||
        item.id === undefined ||
        item.id === null ||
        typeof item.full_name !== 'string' ||
        !item.full_name
      )
        throw new Error('GitHub returned a repository without a stable identity.');
      var id = String(item.id),
        name = item.full_name.toLowerCase();
      if (resultIds.indexOf(id) !== -1 || resultNames.indexOf(name) !== -1)
        throw new Error(
          'GitHub returned duplicate repositories while paging. Run the search again.'
        );
      resultIds.push(id);
      resultNames.push(name);
    });
    records = response.items;
    count += records.length;
    if (count > total)
      throw new Error('GitHub returned more repositories than its search total. Run it again.');
    if (count < total)
      nextState = {
        mode: 'search',
        page: page + 1,
        total: total,
        count: count,
        ids: resultIds,
        names: resultNames,
      };
  }
  return {
    columns: columns,
    rows: records.map(function (record) {
      var row = {};
      columns.forEach(function (column) {
        row[column.key] =
          column.key === 'repo_url'
            ? record.html_url
            : column.key === 'license'
              ? record.license
                ? record.license.spdx_id
                : null
              : record[column.key];
      });
      return row;
    }),
    nextState: nextState,
    metadata: {
      complete: nextState === null,
      grain: 'Current repository snapshot',
      note: 'Open issues includes pull requests, as defined by GitHub.',
    },
  };
}

dmvRegisterConnector_({
  id: 'github',
  label: 'GitHub',
  description: 'Research a short list of repositories or a focused search.',
  category: 'Research',
  color: '#24292f',
  icon: {
    viewBox: '0 0 250 250',
    shapes: [
      {
        d: 'M124.621 30C70.713 30 27 73.552 27 127.279c0 42.981 27.971 79.444 66.76 92.308 4.878.9 6.67-2.111 6.67-4.68 0-2.32-.092-9.983-.133-18.112-27.159 5.885-32.89-11.477-32.89-11.477-4.44-11.245-10.839-14.234-10.839-14.234-8.856-6.038.668-5.914.668-5.914 9.803.687 14.965 10.025 14.965 10.025 8.707 14.872 22.837 10.572 28.408 8.087.876-6.288 3.406-10.579 6.197-13.008-21.682-2.46-44.476-10.802-44.476-48.076 0-10.62 3.813-19.298 10.058-26.11-1.013-2.451-4.354-12.345.946-25.744 0 0 8.198-2.615 26.853 9.971 7.786-2.156 16.138-3.236 24.434-3.273 8.296.037 16.654 1.117 24.456 3.273 18.633-12.586 26.819-9.971 26.819-9.971 5.313 13.399 1.97 23.293.957 25.743 6.259 6.813 10.046 15.49 10.046 26.111 0 37.363-22.837 45.59-44.574 47.998 3.501 3.019 6.621 8.94 6.621 18.015 0 13.015-.114 23.491-.114 26.696 0 2.588 1.757 5.622 6.706 4.667 38.767-12.878 66.703-49.329 66.703-92.295 0-53.727-43.707-97.279-97.62-97.279Z',
        fill: '#181717',
      },
      {
        d: 'M63.562 168.576c-.215.483-.979.628-1.673.297-.708-.318-1.106-.977-.877-1.462.21-.498.975-.637 1.682-.302.71.316 1.114.982.868 1.467Zm4.802 4.269c-.466.43-1.376.231-1.994-.449-.638-.678-.758-1.585-.285-2.022.48-.43 1.362-.229 2.003.45.638.686.762 1.587.275 2.022v-.001Zm3.294 5.463c-.598.414-1.577.026-2.18-.839-.599-.865-.599-1.902.012-2.318.607-.416 1.57-.042 2.182.816.597.88.597 1.917-.014 2.342v-.001Zm5.571 6.327c-.535.587-1.674.43-2.509-.372-.853-.785-1.09-1.898-.554-2.486.541-.589 1.687-.424 2.528.372.847.783 1.106 1.904.536 2.486Zm7.2 2.136c-.235.761-1.333 1.108-2.439.784-1.104-.333-1.826-1.226-1.603-1.995.23-.767 1.332-1.128 2.446-.782 1.102.332 1.826 1.218 1.597 1.993h-.001Zm8.195.906c.028.802-.91 1.468-2.07 1.482-1.168.025-2.112-.624-2.125-1.413 0-.81.917-1.469 2.084-1.488 1.16-.023 2.111.621 2.111 1.419Zm8.05-.308c.139.783-.668 1.587-1.82 1.801-1.133.206-2.182-.277-2.327-1.053-.14-.803.682-1.606 1.813-1.814 1.154-.2 2.187.27 2.334 1.066',
        fill: '#181717',
      },
    ],
  },
  allowedHosts: ['api.github.com'],
  guide: {
    intro:
      'Public repositories work without a token; a fine-grained token adds private repositories and higher limits.',
    steps: [
      'GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.',
      'Choose the repositories to read and grant Contents, Issues, Pull requests and Metadata read access.',
    ],
    links: [{ label: 'Personal access tokens', url: 'https://github.com/settings/tokens' }],
  },
  authFields: [
    {
      key: 'token',
      label: 'Personal access token',
      type: 'password',
      required: false,
      help: 'Recommended for higher rate limits; required for private repositories.',
    },
  ],
  test: function (ctx) {
    ctx.http({
      url: 'https://api.github.com/rate_limit',
      headers: dmvGithubHeaders_(ctx.credentials),
    });
  },
  reports: [
    {
      id: 'repository_overview',
      label: 'Repository overview',
      description: 'Stars, forks, language, activity and key repository details.',
      fields: dmvGithubFields_(),
      dateRange: false,
      configFields: [
        {
          key: 'query',
          label: 'Repository search',
          type: 'text',
          help: 'For example: topic:analytics stars:>500',
        },
        {
          key: 'repositories',
          label: 'Repository list (optional)',
          type: 'textarea',
          help: 'URLs or owner/repository names, one per line. A list takes precedence over search.',
        },
      ],
      fetch: dmvGithubFetch_,
      fetchChunk: dmvGithubFetchChunk_,
    },
  ],
});
