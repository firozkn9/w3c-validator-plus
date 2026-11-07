// Loaded once per tab; must only touch the current tab.
function initTab($tab, tabSelector) {
  $(".name").val("");                 // line 3: page-wide → warning
  $tab.find(".name").val("");         // scoped
  $(tabSelector + " .total").text(0); // scoped
  $(document).find(".row").remove();  // line 6: page-wide → warning
  $("#saveBtn").prop("disabled", true);
}
