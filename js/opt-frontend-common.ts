

/// <reference path="_references.ts" />

// for TypeScript
declare var diff_match_patch: any;
declare var codeopticonUsername: string; // FIX later when porting Codeopticon
declare var codeopticonSession: string;  // FIX later when porting Codeopticon

require('./lib/diff_match_patch.js');
require('./lib/jquery.ba-dotimeout.min.js');

// need to directly import the class for type checking to work
import {ExecutionVisualizer, assert, htmlspecialchars} from './pytutor';
export abstract class AbstractBaseFrontend {
  sessionUUID: string = generateUUID(); // remains constant throughout one page load ("session")
  userUUID: string; // remains constant for a particular "user" throughout multiple page loads (stored in localStorage on a particular browser)

  myVisualizer: ExecutionVisualizer;
  originFrontendJsFile: string; // "abstract" -- must override in subclass

  // 'edit' or 'display'. also support 'visualize' for backward
  // compatibility (same as 'display')
  appMode: string = 'edit';

  // inputted by user for raw_input / mouse_input events
  rawInputLst: string[] = [];

  isExecutingCode: boolean = false;

  // optional: not all frontends keep track of deltas
  dmp = new diff_match_patch();
  curCode = ''; // for dmp snapshots, kinda kludgy
  deltaObj : {start: string, deltas: any[], v: number, startTime: number, executeTime?: number} = undefined;

  num414Tries = 0;

  // note that we use '2' and '3' instead of 'py2' and 'py3' due to legacy reasons
  langSettingToBackendScript = {
    // backend scripts to execute (Python 2 and 3 variants, if available)
    // make two copies of ../web_exec.py and give them the following names,
    // then change the first line (starting with #!) to the proper version
    // of the Python interpreter (i.e., Python 2 or Python 3).
    // Note that your hosting provider might have stringent rules for what
    // kind of scripts are allowed to execute. For instance, my provider
    // (Webfaction) seems to let scripts execute only if permissions are
    // something like:
    // -rwxr-xr-x 1 pgbovine pgbovine 2.5K Jul  5 22:46 web_exec_py2.py*
    // (most notably, only the owner of the file should have write
    //  permissions)
    '2': 'web_exec_py2.py',
    '3': 'web_exec_py3.py',

    // empty dummy scripts just to do logging on Apache server
    'js':   'web_exec_js.py',
    'ts':   'web_exec_ts.py',
    'java': 'web_exec_java.py',
    'ruby': 'web_exec_ruby.py',
    'c':   'web_exec_c.py',
    'cpp': 'web_exec_cpp.py',
  };

  // these settings are all customized for my own server setup,
  // so you will need to customize for your server:
  serverRoot = (window.location.protocol === 'https:') ?
                'https://cokapi.com/' : // my certificate for https is registered via cokapi.com, so use it for now
                'http://cokapi.com/';   // try cokapi.com so that hopefully it works through firewalls better than directly using IP addr

  backupHttpServerRoot = 'http://45.33.41.179/'; // this is my backup server in case the primary is too busy

  // see ../../v4-cokapi/cokapi.js for details
  langSettingToJsonpEndpoint = {
    '2':    null,
    '3':    null,
    'js':   this.serverRoot + 'exec_js_jsonp',
    'ts':   this.serverRoot + 'exec_ts_jsonp',
    'java': this.serverRoot + 'exec_java_jsonp',
    'ruby': this.serverRoot + 'exec_ruby_jsonp',
    'c':    this.serverRoot + 'exec_c_jsonp',
    'cpp':  this.serverRoot + 'exec_cpp_jsonp',
  };

  langSettingToJsonpEndpointBackup = {
    '2':    null,
    '3':    null,
    'js':   this.backupHttpServerRoot + 'exec_js_jsonp',
    'ts':   this.backupHttpServerRoot + 'exec_ts_jsonp',
    'java': this.backupHttpServerRoot + 'exec_java_jsonp',
    'ruby': this.backupHttpServerRoot + 'exec_ruby_jsonp',
    'c':    this.backupHttpServerRoot + 'exec_c_jsonp',
    'cpp':  this.backupHttpServerRoot + 'exec_cpp_jsonp',
  };

  abstract executeCode(forceStartingInstr?: number, forceRawInputLst?: string[]) : any;
  abstract finishSuccessfulExecution() : any; // called by executeCodeAndCreateViz
  abstract handleUncaughtException(trace: any[]) : any; // called by executeCodeAndCreateViz

  constructor(params: any = {}) {
    // OMG nasty wtf?!?
    // From: http://stackoverflow.com/questions/21159301/quotaexceedederror-dom-exception-22-an-attempt-was-made-to-add-something-to-st
    // Safari, in Private Browsing Mode, looks like it supports localStorage but all calls to setItem
    // throw QuotaExceededError. We're going to detect this and just silently drop any calls to setItem
    // to avoid the entire page breaking, without having to do a check at each usage of Storage.
    if (typeof localStorage === 'object') {
      try {
        localStorage.setItem('localStorage', '1');
        localStorage.removeItem('localStorage');
      } catch (e) {
        (Storage as any).prototype._setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function() {}; // make it a NOP
        alert('Your web browser does not support storing settings locally. In Safari, the most common cause of this is using "Private Browsing Mode". Some features may not work properly for you.');
      }
    }

    if (supports_html5_storage()) {
      // generate a unique UUID per "user" (as indicated by a single browser
      // instance on a user's machine, which can be more precise than IP
      // addresses due to sharing of IP addresses within, say, a school
      // computer lab)
      // added on 2015-01-27 for more precise user identification
      if (!localStorage.getItem('opt_uuid')) {
        localStorage.setItem('opt_uuid', generateUUID());
      }

      this.userUUID = localStorage.getItem('opt_uuid');
      assert(this.userUUID);
    } else {
      this.userUUID = undefined;
    }

    // register a generic AJAX error handler
    $(document).ajaxError((evt, jqxhr, settings, exception) => {
      if (this.ignoreAjaxError(settings)) {
        return; // early return!
      }

      // On my server ...

      // This jqxhr.responseText might mean the URL is too long, since the error
      // message returned by the server is something like this in nginx:
      //
      //   <html>
      //   <head><title>414 Request-URI Too Large</title></head>
      //   <body bgcolor="white">
      //   <center><h1>414 Request-URI Too Large</h1></center>
      //   <hr><center>nginx</center>
      //   </body>
      //   </html>
      //
      // Note that you'll probably need to customize this check for your server.
      if (jqxhr && jqxhr.responseText && jqxhr.responseText.indexOf('414') >= 0) {
        // ok this is an UBER UBER hack. If this happens just once, then
        // force click the "Visualize Execution" button again and re-try.
        // why? what's the difference the second time around? the diffs_json
        // parameter (derived from deltaObj) will be *empty* the second time
        // around since it gets reset on every execution. if diffs_json is
        // HUGE, then that might force the URL to be too big without your
        // code necessarily being too big, so give it a second shot with an
        // empty diffs_json. if it STILL fails, then display the error
        // message and give up.
        if (this.num414Tries === 0) {
          this.num414Tries++;
          $("#executeBtn").click();
        } else {
          this.setFronendError(["Server error! Your code might be too long for this tool. Shorten your code and re-try. [#CodeTooLong]"]);
          this.num414Tries = 0; // reset this to 0 AFTER setFronendError so that in setFronendError we can know that it's a 414 error (super hacky!)
          this.doneExecutingCode();
        }
      } else {
        this.setFronendError(
                        ["Server error! Your code might have an INFINITE LOOP or be running for too long.",
                         "The server may also be OVERLOADED. Or you're behind a FIREWALL that blocks access.",
                         "Try again later, or report a bug to philip@pgbovine.net", ]);
      }
      this.doneExecutingCode();
    });

    this.clearFrontendError();
    $("#embedLinkDiv").hide();
    $("#executeBtn")
      .attr('disabled', false)
      .click(this.executeCodeFromScratch.bind(this));
  }

  ignoreAjaxError(settings) {return false;} // subclasses should override

  // empty stub so that our code doesn't crash.
  // TODO: override this with a version in codeopticon-learner.js if needed
  logEventCodeopticon(obj) { } // NOP

  getAppState() {return {};} // NOP -- subclasses need to override

  setFronendError(lines, ignoreLog=false) {
    $("#output_ex").html(lines);

    // log it to the server as well (unless ignoreLog is on)
    if (!ignoreLog) {
      var errorStr = lines.join();

      var myArgs = this.getAppState();
      (myArgs as any).opt_uuid = this.userUUID;
      (myArgs as any).session_uuid = this.sessionUUID;
      (myArgs as any).error_msg = errorStr;

      // very subtle! if you have a 414 error, that means your original
      // code was too long to fit in the URL, so CLEAR THE FULL CODE from
      // myArgs, or else it will generate a URL that will give a 414 again
      // when you run error_log.py!!! this relies on this.num414Tries not
      // being reset yet at this point:
      if (this.num414Tries > 0) {
        (myArgs as any).code = '#CodeTooLong: ' + String((myArgs as any).code.length) + ' bytes';
      }
      $.get('error_log.py', myArgs, function(dat) {}); // added this logging feature on 2018-02-18
    }
  }

  clearFrontendError() {
    $("#frontendErrorOutput").html('');
  }

  // parsing the URL query string hash
  getQueryStringOptions() {
    var ril = $.bbq.getState('rawInputLstJSON');
    var testCasesLstJSON = $.bbq.getState('testCasesJSON');
    // note that any of these can be 'undefined'
    return {preseededCode: $.bbq.getState('code'),
            preseededCurInstr: Number($.bbq.getState('curInstr')),
            verticalStack: $.bbq.getState('verticalStack'),
            appMode: $.bbq.getState('mode'),
            py: $.bbq.getState('py'),
            cumulative: $.bbq.getState('cumulative'),
            heapPrimitives: $.bbq.getState('heapPrimitives'),
            textReferences: $.bbq.getState('textReferences'),
            rawInputLst: ril ? $.parseJSON(ril) : undefined,
            codeopticonSession: $.bbq.getState('cosession'),
            codeopticonUsername: $.bbq.getState('couser'),
            testCasesLst: testCasesLstJSON ? $.parseJSON(testCasesLstJSON) : undefined
            };
  }

  redrawConnectors() {
    if (this.myVisualizer &&
        (this.appMode == 'display' ||
         this.appMode == 'visualize' /* deprecated */)) {
      this.myVisualizer.redrawConnectors();
    }
  }

  getBaseBackendOptionsObj() {
    var ret = {cumulative_mode: ($('#cumulativeModeSelector').val() == 'true'),
               heap_primitives: ($('#heapPrimitivesSelector').val() == 'true'),
               show_only_outputs: false, // necessary for legacy reasons, ergh!
               origin: this.originFrontendJsFile};
    return ret;
  }

  getBaseFrontendOptionsObj() {
    var ret = {// tricky: selector 'true' and 'false' values are strings!
                disableHeapNesting: ($('#heapPrimitivesSelector').val() == 'true'),
                textualMemoryLabels: ($('#textualMemoryLabelsSelector').val() == 'true'),
                executeCodeWithRawInputFunc: this.executeCodeWithRawInput.bind(this),

                // always use the same visualizer ID for all
                // instantiated ExecutionVisualizer objects,
                // so that they can sync properly across
                // multiple clients using TogetherJS in shared sessions.
                // this shouldn't lead to problems since only ONE
                // ExecutionVisualizer will be shown at a time
                visualizerIdOverride: '1',
                updateOutputCallback: this.updateOutputCallbackFunc.bind(this),
                startingInstruction: 0,
              };
    return ret;
  }

  updateOutputCallbackFunc() {
    $('#urlOutput,#urlOutputShortened,#embedCodeOutput').val('');
  }

  executeCodeFromScratch() {
    this.rawInputLst = []; // reset!
    this.executeCode();
  }

  executeCodeWithRawInput(rawInputStr, curInstr) {
    this.rawInputLst.push(rawInputStr);
    this.executeCode(curInstr);
  }

  startExecutingCode(startingInstruction=0) {
    $('#executeBtn').html("Please wait ... Your code is Executing");
    $('#executeBtn').attr('disabled', true);
    this.isExecutingCode = true;
  }

  doneExecutingCode() {
    $('#executeBtn').html("Visualize Execution");
    $('#executeBtn').attr('disabled', false);
    this.isExecutingCode = false;
  }

  // execute codeToExec and create a new ExecutionVisualizer
  // object with outputDiv as its DOM parent
  executeCodeAndCreateViz(codeToExec,
                          pyState,
                          backendOptionsObj, frontendOptionsObj,
                          outputDiv) {
    var vizCallback = (dataFromBackend) => {
      var trace = dataFromBackend.trace;
      // don't enter visualize mode if there are killer errors:
      if (!trace ||
          (trace.length == 0) ||
          (trace[trace.length - 1].event == 'uncaught_exception')) {
        this.handleUncaughtException(trace);

        if (trace.length == 1) {
          this.setFronendError([trace[0].exception_msg]);
        } else if (trace.length > 0 && trace[trace.length - 1].exception_msg) {
          this.setFronendError([trace[trace.length - 1].exception_msg]);
        } else {
          this.setFronendError(
                          ["Unknown error: The server may be OVERLOADED right now; try again later.",
                           "Your code may also contain UNSUPPORTED FEATURES that this tool cannot handle.",
                           "Report a bug to philip@pgbovine.net"]);
        }
      } else {
        // fail-soft to prevent running off of the end of trace
        if (frontendOptionsObj.startingInstruction >= trace.length) {
          frontendOptionsObj.startingInstruction = 0;
        }

        if (frontendOptionsObj.runTestCaseCallback) {
          // hacky! DO NOT actually create a visualization! instead call:
          frontendOptionsObj.runTestCaseCallback(trace);
        } else {
          // success!
          this.myVisualizer = new ExecutionVisualizer(outputDiv, dataFromBackend, frontendOptionsObj);
          // SUPER HACK -- slip in backendOptionsObj as an extra field
          // NB: why do we do this? for more detailed logging?
          (this.myVisualizer as any).backendOptionsObj = backendOptionsObj;
          this.finishSuccessfulExecution(); // TODO: should we also run this if we're calling runTestCaseCallback?
        }
      }
    }

    this.executeCodeAndRunCallback(codeToExec,
                                   pyState,
                                   backendOptionsObj, frontendOptionsObj,
                                   vizCallback.bind(this));
  }

  // execute code and call the execCallback function when the server
  // returns data via Ajax
  executeCodeAndRunCallback(codeToExec,
                            pyState,
                            backendOptionsObj, frontendOptionsObj,
                            execCallback) {
      var callbackWrapper = (dataFromBackend) => {
        this.clearFrontendError(); // clear old errors first; execCallback may put in a new error:

        execCallback(dataFromBackend); // call the main event first

        // run this at the VERY END after all the dust has settled
        this.doneExecutingCode(); // rain or shine, we're done executing!
        // tricky hacky reset
        this.num414Tries = 0;
      };

      var backendScript = this.langSettingToBackendScript[pyState];
      assert(backendScript);
      var jsonp_endpoint = this.langSettingToJsonpEndpoint[pyState]; // maybe null

      if (!backendScript) {
        this.setFronendError(
                        ["Server configuration error: No backend script",
                         "Report a bug to philip@pgbovine.net by clicking on the 'Generate shortened link'",
                         "button at the bottom and including a URL in your email."]);
        return;
      }

      this.clearFrontendError();
      this.startExecutingCode(frontendOptionsObj.startingInstruction);

      frontendOptionsObj.lang = pyState;
      // kludgy exceptions
      if (pyState === '2') {
        frontendOptionsObj.lang = 'py2';
      } else if (pyState === '3') {
        frontendOptionsObj.lang = 'py3';
      } else if (pyState === 'java') {
        frontendOptionsObj.disableHeapNesting = true; // never nest Java objects, seems like a good default
      }

      // if we don't have any deltas, then don't bother sending deltaObj:
      // NB: not all subclasses will initialize this.deltaObj
      var deltaObjStringified = (this.deltaObj && (this.deltaObj.deltas.length > 0)) ? JSON.stringify(this.deltaObj) : null;
      if (deltaObjStringified) {
        // if deltaObjStringified is too long, then that will likely make
        // the URL way too long. in that case, just make it null and don't
        // send a delta (NB: actually set it to a canary value "overflow").
        // we'll lose some info but at least the URL will hopefully not overflow:
        if (deltaObjStringified.length > 4096) {
          deltaObjStringified = "overflow"; // set a canary to overflow
        }
      } else {
        // if we got here due to the num414Tries retries hack, set
        // canary to "overflow"
        if (this.num414Tries > 0) {
          deltaObjStringified = "overflow_414";
        }
      }

      if (jsonp_endpoint) {
        assert (pyState !== '2' && pyState !== '3');

        var retryOnBackupServer = () => {
          // first log a #TryBackup error entry:
          this.setFronendError(["Main server is busy or has errors; re-trying using backup server ... [#TryBackup]"]);

          // now re-try the query using the backup server:
          var backup_jsonp_endpoint = this.langSettingToJsonpEndpointBackup[pyState];
          assert(backup_jsonp_endpoint);
          $.ajax({
            url: backup_jsonp_endpoint,
            // The name of the callback parameter, as specified by the YQL service
            jsonp: "callback",
            dataType: "jsonp",
            data: {user_script : codeToExec,
                   options_json: JSON.stringify(backendOptionsObj)},
            success: callbackWrapper
          });
        }

        // for non-python, this should be a dummy script for logging
        // only, and to check whether there's a 414 error for #CodeTooLong
        $.get(backendScript,
              {user_script : codeToExec,
               options_json: JSON.stringify(backendOptionsObj),
               user_uuid: this.userUUID,
               session_uuid: this.sessionUUID,
               diffs_json: deltaObjStringified},
               (dat) => {
                // this is super important! only if this first call is a
                // SUCCESS do we actually make the REAL call using JSONP.
                // the reason why is that we might get a 414 error for
                // #CodeTooLong if we try to execute this code, in which
                // case we want to either re-try or bail out. this also
                // keeps the control flow synchronous. we always try
                // the original backendScript, and then we try
                // jsonp_endpoint only if that's successful:

                // the REAL call uses JSONP
                // http://learn.jquery.com/ajax/working-with-jsonp/
                $.ajax({
                  url: jsonp_endpoint,

                  // for testing
                  //url: 'http://cokapi.com/test_failure_jsonp',
                  //url: 'http://cokapi.com/unknown_url',

                  // The name of the callback parameter, as specified by the YQL service
                  jsonp: "callback",
                  dataType: "jsonp",
                  data: {user_script : codeToExec,
                         options_json: JSON.stringify(backendOptionsObj)},
                  success: (dataFromBackend) => {
                    var trace = dataFromBackend.trace;
                    var shouldRetry = false;

                    // the cokapi backend responded successfully, but the
                    // backend may have issued an error. if so, then
                    // RETRY with backupHttpServerRoot. otherwise let it
                    // through to callbackWrapper
                    if (!trace ||
                        (trace.length == 0) ||
                        (trace[trace.length - 1].event == 'uncaught_exception')) {
                      if (trace.length == 1) {
                        // we should only retry if there's a legit
                        // backend error and not just a syntax error:
                        var msg = trace[0].exception_msg;
                        if (msg.indexOf('#BackendError') >= 0) {
                          shouldRetry = true;
                        }
                      } else {
                        shouldRetry = true;
                      }
                    }

                    // don't bother re-trying for https since we don't
                    // currently have an https backup server
                    if (window.location.protocol === 'https:') {
                      shouldRetry = false;
                    }

                    if (shouldRetry) {
                      retryOnBackupServer();
                    } else {
                      // accept our fate without retrying
                      callbackWrapper(dataFromBackend);
                    }
                  },
                  // if there's a server error, then ALWAYS retry:
                  error: (jqXHR, textStatus, errorThrown) => {
                    retryOnBackupServer();
                    // use 'global: false;' below to NOT run the generic ajaxError() function
                  },

                  global: false, // VERY IMPORTANT! do not call the generic ajaxError() function when there's an error;
                                 // only call our error handler above; http://api.jquery.com/ajaxerror/
                });

               }, "text");

      } else {
        // for Python 2 or 3, directly execute backendScript
        assert (pyState === '2' || pyState === '3');
        $.get(backendScript,
              {user_script : codeToExec,
               raw_input_json: this.rawInputLst.length > 0 ? JSON.stringify(this.rawInputLst) : '',
               options_json: JSON.stringify(backendOptionsObj),
               user_uuid: this.userUUID,
               session_uuid: this.sessionUUID,
               diffs_json: deltaObjStringified},
               callbackWrapper, "json");
      }
  }

  setSurveyHTML() {
    // use ${this.userUUID} within the string ...
    var survey_v14 = `
    <p style="font-size: 9pt; margin-top: 12px; margin-bottom: 15px; line-height: 150%;">

    Help improve this tool by completing a <a style="font-size: 10pt; font-weight: bold;" href="https://docs.google.com/forms/d/e/1FAIpQLSfQJP1ojlv8XzXAvHz0al-J_Hs3GQu4XeblxT8EzS8dIzuaYA/viewform?entry.956368502=${this.userUUID}" target="_blank">short user survey</a>
    <br/>
    Keep this tool free by making a <a style="font-size: 10pt; font-weight: bold;" href="http://pgbovine.net/support.htm" target="_blank">small donation</a> (PayPal, Patreon, credit/debit card)
    </p>`;
    $('#surveyPane').html(survey_v14);
  }
} // END class AbstractBaseFrontend



// misc utilities:

// From http://stackoverflow.com/a/8809472
export function generateUUID(){
    var d = new Date().getTime();
    var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = (d + Math.random()*16)%16 | 0;
        d = Math.floor(d/16);
        return (c=='x' ? r : (r&0x7|0x8)).toString(16);
    });
    return uuid;
};

// From http://diveintohtml5.info/storage.html
export function supports_html5_storage() {
  try {
    return 'localStorage' in window && window['localStorage'] !== null;
  } catch (e) {
    return false;
  }
}
