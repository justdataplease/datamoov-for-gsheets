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
  var columns = dmvSelectFields_(ctx.fields, dmvGithubFields_());
  var list = String(ctx.config.repositories || '').trim();
  var query = String(ctx.config.query || '').trim();
  var headers = dmvGithubHeaders_(ctx.credentials);
  var records = [];
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
    names.forEach(function (name) {
      ctx.checkDeadline();
      records.push(ctx.http({ url: 'https://api.github.com/repos/' + name, headers: headers }));
    });
  } else {
    if (!query) throw new Error('Enter a GitHub search or a repository list.');
    var page = 1,
      total = null,
      resultIds = Object.create(null),
      resultNames = Object.create(null);
    do {
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
      if (!Array.isArray(response.items) || !Number.isInteger(response.total_count))
        throw new Error('GitHub returned an invalid search page.');
      if (total === null) total = response.total_count;
      else if (total !== response.total_count)
        throw new Error('GitHub search changed during pagination. Run it again.');
      if (total > Math.min(ctx.maxRows, 1000))
        throw new Error(
          "The search exceeds the row limit or GitHub's 1,000-result cap. Narrow the search."
        );
      if (!response.items.length && records.length < total)
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
        if (resultIds[id] || resultNames[name])
          throw new Error(
            'GitHub returned duplicate repositories while paging. Run the search again.'
          );
        resultIds[id] = true;
        resultNames[name] = true;
      });
      records = records.concat(response.items);
      if (records.length > total)
        throw new Error('GitHub returned more repositories than its search total. Run it again.');
      page++;
    } while (records.length < total);
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
    metadata: {
      complete: true,
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
  allowedHosts: ['api.github.com'],
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
    },
  ],
});
