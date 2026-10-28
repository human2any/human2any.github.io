// Contents rail: highlight the section in view and fill the progress line
document.addEventListener('DOMContentLoaded', () => {
  const contents = document.querySelector('.contents');
  const links = document.querySelectorAll('.contents a');
  if (!contents || !links.length) return;

  const milestones = [...links]
    .map((link) => ({ link, target: document.querySelector(link.hash) }))
    .filter(({ target }) => Boolean(target));
  if (!milestones.length) return;

  const top = (el) => el.getBoundingClientRect().top + window.scrollY;

  const update = () => {
    const marker = window.scrollY + window.innerHeight * 0.35;
    const atPageEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    const tops = milestones.map(({ target }) => top(target));

    let activeIndex = 0;
    tops.forEach((t, i) => { if (marker >= t) activeIndex = i; });
    if (atPageEnd) activeIndex = milestones.length - 1;

    let progress = 0;
    for (let i = 0; i < tops.length - 1; i += 1) {
      if (marker < tops[i]) break;
      progress = (i + Math.min(1, (marker - tops[i]) / (tops[i + 1] - tops[i]))) / (tops.length - 1);
    }
    if (atPageEnd || marker >= tops[tops.length - 1]) progress = 1;

    contents.style.setProperty('--contents-progress', progress);
    milestones.forEach(({ link }, i) => {
      const li = link.closest('li');
      link.classList.toggle('active', i === activeIndex);
      li.classList.toggle('is-active', i === activeIndex);
      li.classList.toggle('is-past', i < activeIndex);
      if (i === activeIndex) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  };

  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  window.addEventListener('load', update);
  update();
});

// Copy BibTeX to clipboard
document.addEventListener('DOMContentLoaded', () => {
  const copyButton = document.querySelector('[data-copy-citation]');
  if (!copyButton) return;
  copyButton.addEventListener('click', async () => {
    const citation = document.querySelector('[data-citation]')?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(citation);
      copyButton.textContent = 'Copied';
      setTimeout(() => { copyButton.textContent = 'Copy'; }, 1800);
    } catch {
      copyButton.textContent = 'Select text';
    }
  });
});
