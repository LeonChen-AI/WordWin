// custom-dropdown.js — Replaces native <select> dropdowns with styled div-based dropdowns
// Usage: call initCustomDropdowns() after DOM is ready

(function () {
  'use strict';

  let activeDropdown = null;

  document.addEventListener('click', (e) => {
    if (activeDropdown && !activeDropdown.wrapper.contains(e.target)) {
      closeDropdown(activeDropdown);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeDropdown) {
      closeDropdown(activeDropdown);
    }
  });

  let scrollHandler = null;

  function closeDropdown(dd) {
    dd.panel.classList.remove('open');
    dd.wrapper.classList.remove('focused');
    if (activeDropdown === dd) activeDropdown = null;
    if (scrollHandler) {
      window.removeEventListener('scroll', scrollHandler, true);
      window.removeEventListener('resize', scrollHandler);
      scrollHandler = null;
    }
  }

  function openDropdown(dd) {
    if (activeDropdown && activeDropdown !== dd) {
      closeDropdown(activeDropdown);
    }
    // Position panel using fixed + viewport coords to escape overflow:hidden ancestors
    const rect = dd.wrapper.getBoundingClientRect();
    const panelStyle = dd.panel.style;
    panelStyle.position = 'fixed';
    // Measure widest option — temporarily reveal panel off-screen to get real widths
    panelStyle.visibility = 'hidden';
    panelStyle.display = 'block';
    panelStyle.position = 'fixed';
    panelStyle.left = '-9999px';
    panelStyle.top = '-9999px';
    let maxW = rect.width;
    dd.panel.querySelectorAll('.cd-option').forEach(opt => {
      const w = opt.scrollWidth + 32; // extra padding for safety
      if (w > maxW) maxW = w;
    });
    panelStyle.visibility = '';
    panelStyle.display = 'none';
    panelStyle.minWidth = maxW + 'px';
    panelStyle.width = 'auto';
    panelStyle.left = rect.left + 'px';
    // #3: Prevent panel from overflowing right edge of viewport
    const rightEdge = rect.left + maxW;
    if (rightEdge > window.innerWidth - 8) {
      panelStyle.left = Math.max(8, window.innerWidth - maxW - 8) + 'px';
    }

    const panelMaxH = parseInt(getComputedStyle(dd.panel).maxHeight) || 340;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;

    if (spaceBelow >= panelMaxH || spaceBelow >= spaceAbove) {
      panelStyle.top = (rect.bottom + 4) + 'px';
      panelStyle.bottom = 'auto';
    } else {
      panelStyle.bottom = (window.innerHeight - rect.top + 4) + 'px';
      panelStyle.top = 'auto';
    }

    dd.panel.classList.add('open');
    dd.wrapper.classList.add('focused');
    activeDropdown = dd;

    // Close on scroll or resize — but ignore scrolls originating inside the panel
    scrollHandler = (e) => {
      if (e.type === 'scroll' && dd.panel.contains(e.target)) return;
      closeDropdown(dd);
    };
    window.addEventListener('scroll', scrollHandler, true);
    window.addEventListener('resize', scrollHandler);
  }

  function syncDisplay(dd) {
    const selected = dd.select.options[dd.select.selectedIndex];
    if (selected) {
      dd.display.textContent = selected.textContent;
    }
  }

  function createCustomDropdown(select) {
    if (select.dataset.customDropdown || select.dataset.noCustom !== undefined) return;
    select.dataset.customDropdown = '1';

    const wrapper = document.createElement('div');
    wrapper.className = 'cd-dropdown' + (select.className ? ' ' + select.className : '');

    // Copy relevant attributes
    if (select.id) wrapper.dataset.selectId = select.id;

    const display = document.createElement('div');
    display.className = 'cd-display';

    const arrow = document.createElement('span');
    arrow.className = 'cd-arrow';
    arrow.textContent = '▾';

    const panel = document.createElement('div');
    panel.className = 'cd-panel';

    wrapper.appendChild(display);
    wrapper.appendChild(arrow);
    // #7: Append panel to body to escape ancestor overflow:hidden clipping
    document.body.appendChild(panel);
    select.parentNode.insertBefore(wrapper, select.nextSibling);

    const dd = { select, wrapper, display, arrow, panel };

    // Build option items
    function buildOptions() {
      panel.innerHTML = '';
      Array.from(select.options).forEach(opt => {
        const item = document.createElement('div');
        item.className = 'cd-option';
        if (opt.value === select.value) item.classList.add('selected');
        item.dataset.value = opt.value;
        item.textContent = opt.textContent;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          select.value = opt.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          syncDisplay(dd);
          updateOptionStyles(dd);
          closeDropdown(dd);
        });
        panel.appendChild(item);
      });
    }

    buildOptions();
    syncDisplay(dd);

    // Watch for programmatic value changes
    const observer = new MutationObserver(() => {
      syncDisplay(dd);
      updateOptionStyles(dd);
    });
    observer.observe(select, { attributes: true, childList: true });

    // Also intercept .value setter
    const origValueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', {
      get() { return origValueDesc.get.call(this); },
      set(v) {
        origValueDesc.set.call(this, v);
        syncDisplay(dd);
        updateOptionStyles(dd);
      },
      configurable: true,
    });

    // Click to toggle
    wrapper.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel.classList.contains('open')) {
        closeDropdown(dd);
      } else {
        openDropdown(dd);
      }
    });
  }

  function updateOptionStyles(dd) {
    dd.panel.querySelectorAll('.cd-option').forEach(item => {
      item.classList.toggle('selected', item.dataset.value === dd.select.value);
    });
  }

  window.initCustomDropdowns = function () {
    document.querySelectorAll('select').forEach(createCustomDropdown);
  };
})();
