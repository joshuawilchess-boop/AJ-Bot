function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0];
  return d;
}

function makeManualSource(repo) {
  return {
    name: 'manual',
    async addByDomain(input) {
      const domain = normalizeDomain(input);
      if (!domain) throw new Error('domain required');
      return repo.insertSourced({ company: domain, domain, source: 'manual' });
    }
  };
}

module.exports = { makeManualSource, normalizeDomain };
