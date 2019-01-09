import $ from 'jquery';

import { getFilesFromDataTransferItems } from 'datatransfer-files-promise';

import findLCA from 'js/lca';
import html2hext from 'js/html2hext';
import constants from 'js/constants';
import { resize, sendHextUpwards } from 'js/api';

class Extractor {
  constructor(documents) {
    this.documents = documents || [];
    this.LCA = null;
    this.docIx = 0;
    this.selectedEls = [];
    // by default assume we're living inside a workbench module
    // turn this off to disable API functionality
    this.workbench = true;
    this.iframe = null;
  }

  readLocalFiles(files) {
    const promises = files.map(file => {
      // AutoScrape directory files will always have an extension
      if (!file.name.endsWith(".html") && !file.name.endsWith(".css")) {
        return;
      }
      return new Promise((res, rej) => {
        const filepath = file.filepath;
        const start = 0;
        const stop = file.size - 1;
        const blob = file.slice(start, stop + 1);
        const reader = new FileReader();
        reader.onloadend = (e) => {
          if (e.target.readyState == 2) { // DONE
            res({
              "data": e.target.result,
              "name": filepath,
            });
          }
        };
        reader.readAsText(blob);
      });
    }).filter(x => x);
    return Promise.all(promises);
  }

  showDirectoryLoader() {
    const that = this;
    $(constants.controlAreaId).hide();
    $(constants.directoryLoaderId).show();
    const dropArea = document.querySelector(constants.directorySelectorId);
    dropArea.addEventListener('drop', event => {
      event.stopPropagation();
      event.preventDefault();

      const items = event.dataTransfer.items;
      getFilesFromDataTransferItems(items)
        .then(files => {
          return that.readLocalFiles(files);
        })
        .then(results => {
          // group HTML and CSS documents together under the
          // HTML filename's key
          const htmlAndCSS = {};
          results.forEach(result => {
            const matches = result.name.match(/(.*)\.([^\.]{3,})$/);
            const extension = matches[2];
            let filename = result.name;
            // AutoScrape saves CSS as [path].html.css
            if (result.name.endsWith(".css")) {
              filename = matches[1];
            }
            if (!htmlAndCSS[filename]) {
              htmlAndCSS[filename] = {
                name: filename
              };
            }
            htmlAndCSS[filename][extension] = result.data;
          });
          // flatten into an array
          return Object.keys(htmlAndCSS).map(name => {
            const css = htmlAndCSS[name].css;
            const html = htmlAndCSS[name].html;
            return {
              name: name,
              css: css,
              html: html
            };
          });
        })
        .then(results => {
          this.documents = results;
          this.setupSelectionMode();
          this.startSelection();
        })
        .catch(e => {
          console.error("Data transfer error", e);
        });
    }, false);
  }

  showHextTemplate(hext) {
    $(constants.hextOverlayId).show();
    $(constants.hextOverlayId).find("pre").text(hext);
  }

  setupSelectionMode() {
    $(constants.directoryLoaderId).hide();
    $(constants.controlAreaId).show();
    $(constants.nextDocumentId).on(
      "click", this.nextDocument.bind(this)
    );
    $(constants.previousDocumentId).on(
      "click", this.prevDocument.bind(this)
    );
    $(constants.completeSelectionId).on(
      "click", this.selectionComplete.bind(this)
    );

    this.LCA = null;
    this.docIx = 0;
    this.selectedEls = [];
  }

  iframeLoaded(e) {
    const doc = $("iframe");
    const contents = doc.contents();
    const all = contents.find("*");

    all.on("mouseenter mouseover", (e) => {
      e.stopPropagation();
      $(e.target).addClass(constants.overClass);
    });

    all.on("mouseleave mouseout", (e) => {
      e.stopPropagation();
      const jqel = $(e.target);
      jqel.removeClass(constants.overClass);
    });

    all.on("click", (e) => {
      // don't propogate click upwards
      e.preventDefault()
      e.stopPropagation();

      const jqel = $(e.target);
      jqel.addClass(constants.selectedClass);

      // add to selected
      const selIx = this.selectedEls.indexOf(e);
      if(selIx === -1) {
        jqel.addClass(constants.selectedClass);
        this.selectedEls.push(e);
      }
      // remove from selected
      else {
        jqel.removeClass(constants.selectedClass);
        this.selectedEls.splice(selIx, 1);
      }

      // highlight parent element if we have some nodes
      const lca = findLCA(this.selectedEls);
      all.removeClass(constants.selectedParentClass);
      $(lca).addClass(constants.selectedParentClass);

      // this really shouldn't happen anymore. but we have
      // to recover from the possibility somehow
      if (!lca) {
        all.removeClass(constants.selectedParentClass);
        all.removeClass(constants.selectedClass);
        this.selectedEls = [];
      }
      // we have an LCA, grab the outerHTML and display the chunk
      else {
        const re = RegExp(`\\s*${constants.overClass}\\s*`, "g")
        const chunk = lca.outerHTML.replace(re, " ");
        this.LCA = chunk;
      }
    });
  };

  startSelection() {
    const current = this.documents[this.docIx];
    const cleaned = current.html.replace(
      /<script.*>.*<\/script>|<link[^>]*\/>|<style.*>.*<\/style>|<iframe.*>.*<\/iframe>/mg,
      ""
    );
    const iframe = document.createElement('iframe');
    iframe.onload = this.iframeLoaded.bind(this);
    //iframe.sandbox = "allow-scripts allow-same-origin";
    iframe.srcdoc = (
      cleaned +
      `<style>${current.css}</style>` +
      `<style>${constants.autoScrapeStyles}</style>`
    );
    if (this.iframe) {
      $("iframe").remove();
    }
    this.iframe = iframe;
    //$(constants.docAreaId).html(current.html);
    // this is hacky/brittle, find a more robust way to do this
    $(constants.currentDocNameId).val(current.name);
    $(constants.currentNumberId).text(this.docIx + 1);
    $(constants.totalNumberId).text(this.documents.length);
    document.body.appendChild(iframe);
  }

  stopSelection() {
    const doc = $("iframe");
    const contents = doc.contents();
    const all = contents.find("*");
    all.removeClass(constants.overClass);
    all.off();
    all.on("click", (e) => {
      e.preventDefault()
      e.stopPropagation();
    });
    if (this.iframe) {
      $("iframe").remove();
      this.iframe = null;
    }
  }

  selectionComplete() {
    this.stopSelection();
    const hext = html2hext(this.LCA.replace("\n", "").trim());
    if (this.workbench) {
      sendHextUpwards(hext);
    }
    else {
      this.showHextTemplate(hext);
    }
  }

  nextDocument() {
    this.stopSelection();
    this.docIx++;
    this.docIx = this.docIx % this.documents.length;
    this.startSelection();
  }

  prevDocument() {
    this.stopSelection();
    this.docIx--;
    if (this.docIx < 0) {
      this.docIx = this.documents.length - 1;
    }
    this.startSelection();
  }
}

export const startLoading = (d) => {
  const extractor = new Extractor();
  const url = String(window.location).replace(/\/output.*/, '/embeddata');
  fetch(url, { credentials: 'same-origin' })
    .then((response) => {
      if (!response.ok) {
        throw new Error('Invalid response code: ' + response.status)
      }
      return response.json()
    })
    .then((data) => {
      if (!data.html) {
        resize(0);
      }
      else {
        resize(500);
        extractor.documents = data;
        extractor.setupSelectionMode();
        extractor.startSelection();
      }
    })
    .catch((e) => {
      console.error("Failure to load embeddata from API:\n", e);
      extractor.workbench = false;
      extractor.showDirectoryLoader();
    });
};

window.addEventListener('hashchange', startLoading);
startLoading();

