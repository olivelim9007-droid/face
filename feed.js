(function () {
  var popup = document.getElementById('feed-popup');
  var popupVideo = document.getElementById('feed-popup-video');
  var popupImg = document.getElementById('feed-popup-img');
  var backdrop = popup && popup.querySelector('.feed-popup-backdrop');
  var closeBtn = popup && popup.querySelector('.feed-popup-close');

  function openPopup(mediaSrc, isVideo) {
    if (!popup) return;
    popup.classList.remove('is-hidden');
    popup.setAttribute('aria-hidden', 'false');
    popupVideo.classList.add('is-hidden');
    popupImg.classList.add('is-hidden');
    if (isVideo) {
      popupVideo.src = mediaSrc;
      popupVideo.classList.remove('is-hidden');
      popupVideo.muted = false;
      popupVideo.loop = false;
      popupVideo.controls = true;
      popupVideo.play().catch(function () {});
    } else {
      popupImg.src = mediaSrc;
      popupImg.classList.remove('is-hidden');
    }
  }

  function closePopup() {
    if (!popup) return;
    popup.classList.add('is-hidden');
    popup.setAttribute('aria-hidden', 'true');
    if (popupVideo.src) {
      popupVideo.pause();
      popupVideo.src = '';
    }
    popupImg.src = '';
  }

  function onCardClick(e) {
    var card = e.currentTarget;
    var video = card.querySelector('video');
    var img = card.querySelector('img');
    if (video && video.src) {
      e.preventDefault();
      openPopup(video.src, true);
    } else if (img && img.src) {
      e.preventDefault();
      openPopup(img.src, false);
    }
  }

  var cards = document.querySelectorAll('.elem-6, .elem-10, .elem-14, .elem-18, .elem-22, .elem-27');
  cards.forEach(function (el) {
    el.addEventListener('click', onCardClick);
    el.style.cursor = 'pointer';
  });

  if (backdrop) backdrop.addEventListener('click', closePopup);
  if (closeBtn) closeBtn.addEventListener('click', closePopup);
})();
