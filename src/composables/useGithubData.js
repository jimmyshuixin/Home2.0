import { computed, onBeforeUnmount, onMounted, reactive } from 'vue';
import { siteConfig } from '../data/site';

const scheduleIdleTask = (callback, delay = 1400) => {
  if (typeof window === 'undefined') return () => {};

  let idleId;
  const timeoutId = window.setTimeout(() => {
    if ('requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(() => {
        void callback();
      }, { timeout: 4000 });
      return;
    }

    void callback();
  }, delay);

  return () => {
    window.clearTimeout(timeoutId);
    if (idleId) window.cancelIdleCallback?.(idleId);
  };
};

export function useGithubData() {
  const github = reactive({
    stats: { contributions: 0, repos: 0, stars: 0, forks: 0, followers: 0 },
    repos: [],
    pinnedRepos: [],
    isLoading: true,
    updatedAt: '',
    error: '',
  });

  const workerUrl = siteConfig.githubApiUrl;

  const getGithubData = async (endpoint, params = {}) => {
    const url = new URL(workerUrl);
    url.searchParams.set('endpoint', endpoint);
    url.searchParams.set('username', siteConfig.githubUser);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(url.toString(), { signal: controller.signal });
      if (!response.ok) throw new Error('GitHub data unavailable');
      return response.json();
    } finally {
      window.clearTimeout(timeoutId);
    }
  };

  const load = async () => {
    github.isLoading = true;
    github.error = '';
    try {
      const [statsResult, reposResult, pinnedResult] = await Promise.allSettled([
        getGithubData('stats'),
        getGithubData('repos', { page: 1, per_page: 30, sort: 'updated', direction: 'desc' }),
        getGithubData('pinned'),
      ]);

      const hasSyncedData = [statsResult, reposResult, pinnedResult].some((result) => result.status === 'fulfilled');
      if (!hasSyncedData) throw new Error('GitHub data unavailable');

      if (statsResult.status === 'fulfilled') {
        github.stats.repos = statsResult.value.publicRepos || 0;
        github.stats.contributions = statsResult.value.contributions || 0;
        github.stats.followers = statsResult.value.followers || 0;
      }
      if (reposResult.status === 'fulfilled') {
        github.repos = reposResult.value || [];
        const ownedRepos = github.repos.filter((repo) => !repo.fork);
        github.stats.stars = ownedRepos.reduce((sum, repo) => sum + (repo.stargazers_count || 0), 0);
        github.stats.forks = ownedRepos.reduce((sum, repo) => sum + (repo.forks_count || 0), 0);
      }
      if (pinnedResult.status === 'fulfilled') github.pinnedRepos = pinnedResult.value || [];
      github.updatedAt = new Date().toISOString();
      if (hasSyncedData && [statsResult, reposResult, pinnedResult].some((result) => result.status === 'rejected')) {
        github.error = 'GitHub 部分实时数据暂不可用，已展示同步成功的内容。';
      }
    } catch (error) {
      github.error = '暂时无法连接 GitHub，实时内容已隐藏。';
    } finally {
      github.isLoading = false;
    }
  };

  const featuredRepos = computed(() => {
    const pinned = github.pinnedRepos.map((repo) => ({
      name: repo.repo || repo.name,
      description: repo.description || '暂无描述',
      language: repo.language || 'Text',
      stars: repo.stars || 0,
      forks: repo.forks || 0,
      link: repo.link || siteConfig.githubProfile,
      pushedAt: '',
      isPinned: true,
    }));
    const recent = github.repos
      .filter((repo) => !repo.fork)
      .slice()
      .sort((a, b) => new Date(b.pushed_at || 0) - new Date(a.pushed_at || 0))
      .slice(0, 3)
      .map((repo) => ({
        name: repo.name,
        description: repo.description || '暂无描述',
        language: repo.language || 'Text',
        stars: repo.stargazers_count || 0,
        forks: repo.forks_count || 0,
        link: repo.html_url || siteConfig.githubProfile,
        pushedAt: repo.pushed_at || repo.updated_at || '',
        isPinned: false,
      }));
    const uniqueRepos = new Map();
    [...pinned, ...recent].forEach((repo) => {
      if (repo.name && !uniqueRepos.has(repo.name)) uniqueRepos.set(repo.name, repo);
    });
    return Array.from(uniqueRepos.values()).slice(0, 3);
  });

  let cancelInitialLoad;
  onMounted(() => {
    cancelInitialLoad = scheduleIdleTask(load);
  });

  onBeforeUnmount(() => {
    cancelInitialLoad?.();
  });

  return { github, featuredRepos, reloadGithub: load };
}
