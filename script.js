(() => {
  'use strict';

  const STATES = [
    'Acre', 'Alagoas', 'Amapá', 'Amazonas', 'Bahia', 'Ceará',
    'Distrito Federal', 'Espírito Santo', 'Goiás', 'Maranhão',
    'Mato Grosso', 'Mato Grosso do Sul', 'Minas Gerais', 'Pará',
    'Paraíba', 'Paraná', 'Pernambuco', 'Piauí', 'Rio de Janeiro',
    'Rio Grande do Norte', 'Rio Grande do Sul', 'Rondônia', 'Roraima',
    'Santa Catarina', 'São Paulo', 'Sergipe', 'Tocantins'
  ];

  const SERVICES = [
    {
      image: 'twt_icon01.png',
      info: 'Serviços específicos destinados às indústrias farmacêuticas e health care em geral. Somos especializados em transporte de medicamentos e correlatos. Empresa com registro ANVISA.'
    },
    {
      image: 'twt_icon02.png',
      info: 'Serviços indicados para pequenas encomendas oferecendo uma melhor relação de custo e prazo.'
    },
    {
      image: 'twt_icon04.png',
      info: 'Serviço expresso para pequenas encomendas. Consiste no embarque no próximo vôo disponível (independente da companhia aérea) e com entrega imediata no destino após liberação no aeroporto.'
    },
    {
      image: 'twt_icon05.png',
      info: 'Equipe de profissionais avalia logística especial para os casos de grandes volumes e também fracionados, dando tranqüilidade para quem embarca e segurança para quem recebe.'
    },
    {
      image: 'twt_icon08.png',
      info: 'Cargas e encomendas despachadas via malha aérea regular com disponibilidade de acordo com o destino (24, 48 e 72 horas), inclusive com interiorização para mais de 5.000 cidades brasileiras.'
    },
    {
      image: 'twt_icon09.png',
      info: 'Cargas e encomendas expressas com custo reduzido. Consulte regiões atendidas.'
    },
    {
      image: 'twt_icon10.png',
      info: 'Serviço de coletas e entregas ágeis em todo o Rio Grande do Sul.'
    }
  ];

  const FORM_ENDPOINT = 'https://formmail.kinghost.net/formmail.cgi';
  const COOKIE_NAME = 'twtAcceptCookies';

  const createElement = (tagName, options = {}) => {
    const element = document.createElement(tagName);

    if (options.className) element.className = options.className;
    if (options.text) element.textContent = options.text;
    if (options.attributes) {
      Object.entries(options.attributes).forEach(([name, value]) => {
        element.setAttribute(name, value);
      });
    }

    return element;
  };

  class StateDropdown {
    constructor(root, states) {
      this.root = root;
      this.states = states;
      this.isOpen = false;
      this.render();
    }

    render() {
      const dropdown = createElement('div', { className: 'dropdown' });
      this.input = createElement('input', {
        className: 'hidden-estate',
        attributes: { type: 'hidden', name: 'Estado', value: '' }
      });
      this.trigger = createElement('button', {
        className: 'dropdown-value',
        text: 'Estado',
        attributes: {
          type: 'button',
          'aria-haspopup': 'listbox',
          'aria-expanded': 'false',
          'aria-controls': 'stateOptions'
        }
      });

      this.arrow = createElement('span', {
        className: 'dropdown-arrow',
        attributes: { 'aria-hidden': 'true' }
      });
      const arrowImage = createElement('img', {
        attributes: { src: './assets/select-arrow.svg', alt: '' }
      });
      this.arrow.appendChild(arrowImage);

      const panel = createElement('div', { className: 'dropdown-panel' });
      this.list = createElement('div', {
        className: 'dropdown-items',
        attributes: { id: 'stateOptions', role: 'listbox', 'aria-label': 'Estado' }
      });

      this.states.forEach((state) => {
        const option = createElement('button', {
          className: 'dropdown-item',
          text: state,
          attributes: { type: 'button', role: 'option', 'aria-selected': 'false' }
        });
        option.addEventListener('click', () => this.select(option, state));
        this.list.appendChild(option);
      });

      panel.appendChild(this.list);
      dropdown.append(this.input, this.trigger, this.arrow, panel);
      this.root.replaceChildren(dropdown);

      this.trigger.addEventListener('click', () => this.toggle());
      this.trigger.addEventListener('keydown', (event) => this.handleKeydown(event));
      document.addEventListener('click', (event) => {
        if (!this.root.contains(event.target)) this.close();
      });
    }

    select(option, state) {
      this.list.querySelectorAll('[role="option"]').forEach((item) => {
        item.setAttribute('aria-selected', String(item === option));
      });
      this.input.value = state;
      this.trigger.textContent = state;
      this.trigger.classList.add('active-dropdown-value');
      this.close();
      this.trigger.focus();
    }

    handleKeydown(event) {
      if (event.key === 'Escape') {
        this.close();
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.open();
        this.list.querySelector('[role="option"]')?.focus();
      }
    }

    toggle() {
      this.isOpen ? this.close() : this.open();
    }

    open() {
      this.isOpen = true;
      this.list.classList.add('visible');
      this.arrow.classList.add('upsideDown');
      this.trigger.setAttribute('aria-expanded', 'true');
    }

    close() {
      this.isOpen = false;
      this.list.classList.remove('visible');
      this.arrow.classList.remove('upsideDown');
      this.trigger.setAttribute('aria-expanded', 'false');
    }
  }

  class ServiceCarousel {
    constructor(container, infoPanel, services) {
      this.container = container;
      this.infoPanel = infoPanel;
      this.services = services;
      this.activeIndex = null;
      this.dragStartX = 0;
      this.initialScrollLeft = 0;
      this.isDragging = false;
      this.infoTimer = null;

      this.render();
      this.bindDragEvents();
      this.select(0);
    }

    render() {
      const fragment = document.createDocumentFragment();

      this.services.forEach((service, index) => {
        const item = createElement('div', { className: 'item' });
        const button = createElement('button', {
          attributes: {
            type: 'button',
            'aria-label': `Exibir detalhes do serviço ${index + 1}`,
            'aria-expanded': 'false',
            'aria-controls': 'cell-info'
          }
        });
        const actionIcon = createElement('img', {
          attributes: { src: './assets/mais-1.svg', alt: '' }
        });
        const serviceImage = createElement('img', {
          attributes: { src: `./assets/${service.image}`, alt: `Serviço ${index + 1}` }
        });

        button.appendChild(actionIcon);
        button.addEventListener('click', () => this.select(index));
        item.append(button, serviceImage);
        fragment.appendChild(item);
      });

      this.container.replaceChildren(fragment);
    }

    select(index) {
      const buttons = [...this.container.querySelectorAll('.item button')];
      const isClosing = this.activeIndex === index;

      buttons.forEach((button, buttonIndex) => {
        const isActive = !isClosing && buttonIndex === index;
        button.setAttribute('aria-expanded', String(isActive));
        button.querySelector('img').src = isActive
          ? './assets/mais.svg'
          : './assets/mais-1.svg';
      });

      window.clearTimeout(this.infoTimer);
      this.infoPanel.classList.remove('is-visible');

      if (isClosing) {
        this.activeIndex = null;
        return;
      }

      this.activeIndex = index;
      this.infoTimer = window.setTimeout(() => {
        this.infoPanel.textContent = this.services[index].info;
        this.infoPanel.classList.add('is-visible');
      }, 200);
    }

    move(direction) {
      this.enableSmoothScroll();
      const distance = this.itemStep();
      this.container.scrollBy({
        left: direction === 1 ? -distance : distance,
        behavior: 'smooth'
      });
    }

    itemStep() {
      const items = this.container.querySelectorAll('.item');
      if (items.length > 1) {
        const measuredStep = items[1].offsetLeft - items[0].offsetLeft;
        if (measuredStep > 0) return measuredStep;
      }

      const firstItem = items[0];
      if (!firstItem) return 0;
      const styles = window.getComputedStyle(firstItem);
      return firstItem.offsetWidth
        + Number.parseFloat(styles.marginLeft || '0')
        + Number.parseFloat(styles.marginRight || '0');
    }

    bindDragEvents() {
      this.container.addEventListener('pointerdown', (event) => {
        if (event.target.closest('button') || (event.pointerType === 'mouse' && event.button !== 0)) {
          return;
        }

        this.isDragging = true;
        this.dragStartX = event.clientX;
        this.initialScrollLeft = this.container.scrollLeft;
        this.container.classList.add('is-dragging');
        this.container.classList.remove('is-scrolling');
        this.container.setPointerCapture(event.pointerId);
      });

      this.container.addEventListener('pointermove', (event) => {
        if (!this.isDragging) return;
        event.preventDefault();
        this.container.scrollLeft = this.initialScrollLeft - (event.clientX - this.dragStartX);
      });

      ['pointerup', 'pointercancel'].forEach((eventName) => {
        this.container.addEventListener(eventName, () => this.finishDrag());
      });
    }

    finishDrag() {
      if (!this.isDragging) return;
      this.isDragging = false;
      this.enableSmoothScroll();
      const step = this.itemStep();
      if (step) this.container.scrollLeft = Math.round(this.container.scrollLeft / step) * step;
    }

    enableSmoothScroll() {
      this.container.classList.remove('is-dragging');
      this.container.classList.add('is-scrolling');
    }
  }

  const focusOrigins = new WeakMap();

  const syncBodyLock = () => {
    const hasOpenLayer = document.querySelector('#mask.is-open, #mask_rastreamento.is-open, .mobileMenu.is-open');
    document.body.classList.toggle('is-locked', Boolean(hasOpenLayer));
  };

  const setOverlayOpen = (overlay, open, trigger = null) => {
    if (!overlay) return;
    const wasOpen = overlay.classList.contains('is-open');

    if (open && !wasOpen) {
      focusOrigins.set(overlay, trigger ?? document.activeElement);
    }

    overlay.classList.toggle('is-open', open);
    overlay.setAttribute('aria-hidden', String(!open));
    overlay.inert = !open;
    syncBodyLock();

    if (open) {
      window.requestAnimationFrame(() => overlay.querySelector('.close-button')?.focus());
    } else if (wasOpen) {
      focusOrigins.get(overlay)?.focus?.();
      focusOrigins.delete(overlay);
    }
  };

  const trapFocus = (container, event) => {
    if (event.key !== 'Tab' || !container) return;

    const focusable = [...container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((element) => !element.hidden && element.getClientRects().length > 0);

    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const validateEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

  const validatePhone = (value) => [10, 11].includes(value.replace(/\D/g, '').length);

  const hasRepeatedDigits = (digits) => /^(\d)\1+$/.test(digits);

  const validateCpf = (digits) => {
    if (!/^\d{11}$/.test(digits) || hasRepeatedDigits(digits)) return false;

    const calculateDigit = (length) => {
      const sum = digits
        .slice(0, length)
        .split('')
        .reduce((total, digit, index) => total + Number(digit) * (length + 1 - index), 0);
      const result = (sum * 10) % 11;
      return result === 10 ? 0 : result;
    };

    return calculateDigit(9) === Number(digits[9])
      && calculateDigit(10) === Number(digits[10]);
  };

  const validateCnpj = (digits) => {
    if (!/^\d{14}$/.test(digits) || hasRepeatedDigits(digits)) return false;

    const calculateDigit = (base, weights) => {
      const sum = base
        .split('')
        .reduce((total, digit, index) => total + Number(digit) * weights[index], 0);
      const remainder = sum % 11;
      return remainder < 2 ? 0 : 11 - remainder;
    };

    const firstDigit = calculateDigit(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    const secondDigit = calculateDigit(`${digits.slice(0, 12)}${firstDigit}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    return `${firstDigit}${secondDigit}` === digits.slice(-2);
  };

  const validateDocument = (value) => {
    const digits = value.replace(/\D/g, '');
    return digits.length === 11 ? validateCpf(digits) : validateCnpj(digits);
  };

  const updateValidationFeedback = (input, isValid, validLabel, invalidLabel) => {
    const feedback = input.parentElement?.querySelector('.verify-field');
    const icon = feedback?.querySelector('img');

    input.classList.toggle('is-invalid', !isValid);
    input.setAttribute('aria-invalid', String(!isValid));
    input.setCustomValidity(isValid ? '' : invalidLabel);

    if (feedback && icon) {
      icon.src = isValid ? './assets/verify.svg' : './assets/error.svg';
      icon.alt = isValid ? validLabel : invalidLabel;
      feedback.classList.add('is-visible');
    }

    return isValid;
  };

  const validateInteractiveField = (input) => {
    if (input.classList.contains('js-email')) {
      return updateValidationFeedback(input, validateEmail(input.value), 'E-mail válido', 'E-mail inválido');
    }
    if (input.classList.contains('js-phone')) {
      return updateValidationFeedback(input, validatePhone(input.value), 'Telefone válido', 'Telefone inválido');
    }
    if (input.classList.contains('js-document')) {
      return updateValidationFeedback(input, validateDocument(input.value), 'Documento válido', 'CPF ou CNPJ inválido');
    }
    return true;
  };

  const formatPhone = (value) => {
    const digits = value.replace(/\D/g, '').replace(/^0/, '').slice(0, 11);

    if (digits.length > 10) return digits.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3');
    if (digits.length > 6) return digits.replace(/^(\d{2})(\d{4})(\d{0,4})$/, '($1) $2-$3');
    if (digits.length > 2) return digits.replace(/^(\d{2})(\d{0,5})$/, '($1) $2');
    return digits ? `(${digits}` : '';
  };

  const formatDocument = (value) => {
    const digits = value.replace(/\D/g, '');
    if (digits.length <= 11) {
      return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
    }
    return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  };

  const submitForm = async (form, submitButton) => {
    const checkedFields = [...(form?.querySelectorAll('.js-email, .js-phone, .js-document') ?? [])];
    const customFieldsAreValid = checkedFields
      .map((input) => validateInteractiveField(input))
      .every(Boolean);
    if (!customFieldsAreValid) {
      form?.reportValidity();
      return;
    }
    if (!form?.reportValidity()) return;

    const button = submitButton ?? form.querySelector('button[type="submit"], button');
    if (!button) return;

    button.disabled = true;
    button.setAttribute('aria-busy', 'true');

    try {
      const response = await fetch(FORM_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams(new FormData(form)).toString()
      });

      if (!response.ok) throw new Error(`Falha no envio: HTTP ${response.status}`);

      window.alert('E-mail enviado com sucesso!');
      form.reset();
      form.querySelectorAll('.verify-field').forEach((field) => {
        field.classList.remove('is-visible');
        const icon = field.querySelector('img');
        if (icon) {
          icon.src = '';
          icon.alt = '';
        }
      });
      form.querySelectorAll('.is-invalid').forEach((input) => {
        input.classList.remove('is-invalid');
        input.removeAttribute('aria-invalid');
        input.setCustomValidity('');
      });
    } catch (error) {
      console.error(error);
      window.alert('Não foi possível enviar o e-mail. Tente novamente mais tarde.');
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  };

  const hasAcceptedCookies = () => document.cookie
    .split('; ')
    .some((cookie) => cookie === `${COOKIE_NAME}=true`);

  const showCookieConsent = () => {
    if (hasAcceptedCookies() || document.querySelector('.cookieChecker')) return;

    const container = createElement('aside', {
      className: 'cookieChecker',
      attributes: { 'aria-label': 'Aviso de cookies' }
    });
    const message = createElement('p', {
      text: 'Nós usamos cookies para melhorar a sua experiência em nossos serviços. Ao utilizar nossos serviços, você concorda com esse monitoramento.'
    });
    const acceptButton = createElement('button', {
      className: 'button',
      text: 'Aceitar',
      attributes: { type: 'button' }
    });

    acceptButton.addEventListener('click', () => {
      document.cookie = `${COOKIE_NAME}=true; max-age=31536000; path=/; SameSite=Lax`;
      container.remove();
    });

    container.append(message, acceptButton);
    document.body.appendChild(container);
  };

  const initHeader = () => {
    const header = document.getElementById('pageHeader');
    const sections = [...document.querySelectorAll('section[id]')];
    const navigationItems = [...document.querySelectorAll('.menuLink, .mobileLink')];
    let compact = false;
    let ticking = false;

    const updateNavigation = () => {
      const currentSection = sections.reduce((current, section) => (
        window.scrollY + 200 >= section.offsetTop ? section : current
      ), sections[0]);

      navigationItems.forEach((item) => {
        const link = item.querySelector('a[href^="#"]');
        const isCurrent = link?.hash === `#${currentSection?.id}`;
        item.classList.toggle('active', isCurrent);
        if (isCurrent) link?.setAttribute('aria-current', 'page');
        else link?.removeAttribute('aria-current');
      });
    };

    const updateHeader = () => {
      if (window.scrollY > 150 && !compact) {
        compact = true;
        header.classList.add('hideHeader');
        window.setTimeout(() => {
          header.classList.remove('hideHeader');
          header.classList.add('smallHeader');
        }, 200);
      } else if (window.scrollY < 80 && compact) {
        compact = false;
        header.classList.remove('smallHeader', 'hideHeader');
      }

      updateNavigation();
      ticking = false;
    };

    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(updateHeader);
    }, { passive: true });

    updateHeader();
  };

  const init = () => {
    const priceOverlay = document.getElementById('mask');
    const trackingOverlay = document.getElementById('mask_rastreamento');
    const mobileMenu = document.querySelector('.mobileMenu');
    const carouselContainer = document.getElementById('items');
    const carouselInfo = document.getElementById('cell-info');
    const stateRoot = document.getElementById('dropdown-id');

    if (stateRoot) new StateDropdown(stateRoot, STATES);
    const carousel = carouselContainer && carouselInfo
      ? new ServiceCarousel(carouselContainer, carouselInfo, SERVICES)
      : null;

    const menuButtons = [...document.querySelectorAll('.js-show-menu')];
    let menuFocusOrigin = null;

    const openPrice = (event) => setOverlayOpen(priceOverlay, true, event?.currentTarget);
    const closePrice = () => setOverlayOpen(priceOverlay, false);
    const openMenu = (event) => {
      menuFocusOrigin = event?.currentTarget ?? document.activeElement;
      mobileMenu?.classList.add('is-open');
      mobileMenu?.setAttribute('aria-hidden', 'false');
      if (mobileMenu) mobileMenu.inert = false;
      menuButtons.forEach((button) => button.setAttribute('aria-expanded', 'true'));
      syncBodyLock();
      window.requestAnimationFrame(() => mobileMenu?.querySelector('.closeMenu')?.focus());
    };
    const closeMenu = () => {
      const wasOpen = mobileMenu?.classList.contains('is-open');
      mobileMenu?.classList.remove('is-open');
      mobileMenu?.setAttribute('aria-hidden', 'true');
      if (mobileMenu) mobileMenu.inert = true;
      menuButtons.forEach((button) => button.setAttribute('aria-expanded', 'false'));
      syncBodyLock();
      if (wasOpen) menuFocusOrigin?.focus?.();
      menuFocusOrigin = null;
    };

    window.showPrice_rastreamento = (trigger) => setOverlayOpen(trackingOverlay, true, trigger);

    document.querySelectorAll('.js-show-price').forEach((element) => {
      element.addEventListener('click', openPrice);
    });
    document.querySelectorAll('.js-hide-price').forEach((element) => {
      element.addEventListener('click', closePrice);
    });
    menuButtons.forEach((element) => {
      element.addEventListener('click', openMenu);
    });
    document.querySelectorAll('.js-hide-menu').forEach((element) => {
      element.addEventListener('click', closeMenu);
    });
    document.querySelectorAll('.js-hide-tracking').forEach((element) => {
      element.addEventListener('click', () => setOverlayOpen(trackingOverlay, false));
    });
    document.querySelectorAll('.js-carousel').forEach((element) => {
      element.addEventListener('click', () => carousel?.move(Number(element.dataset.direction)));
    });
    document.querySelectorAll('.js-email').forEach((input) => {
      input.addEventListener('blur', () => validateInteractiveField(input));
    });
    document.querySelectorAll('.js-phone').forEach((input) => {
      input.addEventListener('input', () => {
        input.value = formatPhone(input.value);
      });
      input.addEventListener('blur', () => validateInteractiveField(input));
    });
    document.querySelectorAll('.js-document').forEach((input) => {
      input.addEventListener('focus', () => {
        input.value = input.value.replace(/\D/g, '');
      });
      input.addEventListener('blur', () => {
        input.value = formatDocument(input.value);
        validateInteractiveField(input);
      });
    });

    document.querySelector('.js-mobile-price')?.addEventListener('click', () => {
      closeMenu();
      openPrice();
    });

    const messageForm = document.getElementById('messageForm');
    messageForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitForm(messageForm, event.submitter);
    });

    const quotationForm = document.getElementById('cotationForm');
    quotationForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitForm(quotationForm, event.submitter);
    });

    [priceOverlay, trackingOverlay].forEach((overlay) => {
      overlay?.setAttribute('aria-hidden', 'true');
      overlay?.addEventListener('click', (event) => {
        if (event.target === overlay) setOverlayOpen(overlay, false);
      });
    });

    document.addEventListener('keydown', (event) => {
      const openLayer = document.querySelector('#mask.is-open, #mask_rastreamento.is-open, .mobileMenu.is-open');
      trapFocus(openLayer, event);

      if (event.key === 'Escape') {
        closePrice();
        setOverlayOpen(trackingOverlay, false);
        closeMenu();
      }
    });

    const currentYear = document.getElementById('currentYear');
    if (currentYear) currentYear.textContent = String(new Date().getFullYear());

    initHeader();
    showCookieConsent();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
