import {createHash} from 'node:crypto';

// Canvas API integration: individual grade updates and versioned feedback attachments.
// Keeps the original BulkGradeUpdater interface used by cs-546-grader.
const host = 'https://sit.instructure.com/api/v1/';
const canvasOrigin = new URL(host).origin;
const userAgent = 'CS546-Grader/1.0';

const canvasUrl = (path) => {
  const url = new URL(path.replace(/^\/+/, ''), host);

  if (url.protocol !== 'https:' || url.origin !== canvasOrigin) {
    throw new Error('Refusing to send Canvas credentials to another host.');
  }

  return url;
};

const canvasRequest = async (
  path,
  key,
  {method = 'GET', body, contentType} = {}
) => {
  const headers = {
    Authorization: `Bearer ${key}`,
    'User-Agent': userAgent
  };

  if (contentType) {
    headers['Content-Type'] = contentType;
  }

  const response = await fetch(canvasUrl(path), {
    method,
    headers,
    ...(body === undefined ? {} : {body})
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 1500);

    throw new Error(
      `Canvas ${method} ${path}: HTTP ${response.status}: ${details}`
    );
  }

  return response;
};

const responseJson = async (response, description) => {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${description} returned non-JSON data: ${text.slice(0, 500)}`
    );
  }
};

/**
 * Upload a feedback file to Canvas.
 */
const uploadFeedbackFile = async (
  baseEndpoint,
  key,
  studentId,
  filename,
  text
) => {
  const allocation = await canvasRequest(
    `${baseEndpoint}/${studentId}/comments/files`,
    key,
    {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({
        name: filename,
        size: Buffer.byteLength(text, 'utf8'),
        content_type: 'text/plain',
        parent_folder_path: 'autograder/comments'
      })
    }
  );

  const target = await responseJson(allocation, 'Feedback upload allocation');

  if (
    !target.upload_url ||
    !target.upload_params ||
    typeof target.upload_params !== 'object'
  ) {
    throw new Error('Canvas did not return a usable feedback upload target.');
  }

  const form = new FormData();

  for (const [name, value] of Object.entries(target.upload_params)) {
    form.append(name, value);
  }

  form.append('file', new Blob([text], {type: 'text/plain'}), filename);

  // Never send the Canvas API token to the file-upload host.
  const uploaded = await fetch(target.upload_url, {
    method: 'POST',
    body: form,
    redirect: 'manual'
  });

  const location = uploaded.headers.get('location');

  let file;

  if (
    location &&
    (uploaded.status === 201 ||
      (uploaded.status >= 300 && uploaded.status < 400))
  ) {
    const finalUrl = new URL(location, target.upload_url);

    if (finalUrl.protocol !== 'https:' || finalUrl.origin !== canvasOrigin) {
      throw new Error(
        'Upload finalization redirected outside Canvas; not sending token.'
      );
    }

    const finalized = await canvasRequest(finalUrl.href, key);

    file = await responseJson(finalized, 'Feedback upload finalization');
  } else if (uploaded.status === 200 || uploaded.status === 201) {
    file = await responseJson(uploaded, 'Feedback upload');
  } else {
    const details = (await uploaded.text()).slice(0, 1500);

    throw new Error(
      `Feedback file upload: HTTP ${uploaded.status}: ${details}`
    );
  }

  if (!Number.isSafeInteger(Number(file?.id)) || Number(file.id) <= 0) {
    throw new Error(
      `Canvas did not return a valid feedback file ID: ${JSON.stringify(file)}`
    );
  }

  return {
    id: Number(file.id),
    filename
  };
};

/**
 * Retrieve a student's submission and existing comments.
 */
const fetchSubmission = async (baseEndpoint, key, studentId) => {
  const url = canvasUrl(`${baseEndpoint}/${studentId}`);

  url.searchParams.append('include[]', 'submission_comments');

  const response = await canvasRequest(url.href, key);

  return responseJson(response, 'Canvas submission');
};

const attachmentsFor = (submission) =>
  (submission.submission_comments ?? []).flatMap(
    (comment) => comment.attachments ?? []
  );

/**
 * Verify the grade while accounting for Canvas's
 * automatic late penalties.
 *
 * The grader sends the original grade.
 *
 * Canvas may then apply a late penalty, which means:
 *
 *   entered_score = original grade
 *   score = final grade after late penalty
 *
 * If entered_score is unavailable, we can use
 * points_deducted to verify the original grade.
 *
 * IMPORTANT:
 * We do not automatically accept any lower score
 * simply because a submission is late.
 */
const verifyGrade = (submission, expectedGrade) => {
  // Allow for minor rounding differences.
  const tolerance = 0.011;

  const close = (left, right) => Math.abs(left - right) <= tolerance;

  const rawScore = submission?.score;

  const score =
    rawScore === null || rawScore === undefined ? NaN : Number(rawScore);

  const validScore = Number.isFinite(score);

  /*
   * CASE 1:
   * The Canvas grade matches the expected grade.
   *
   * No adjustment is necessary.
   */
  if (validScore && close(score, expectedGrade)) {
    return {
      matches: true,
      lateAdjusted: false
    };
  }

  /*
   * CASE 2:
   * The scores differ.
   *
   * Only account for the difference if Canvas
   * identifies the submission as late.
   */
  const isLate =
    submission?.late === true || submission?.late_policy_status === 'late';

  if (!isLate || !validScore || score > expectedGrade + tolerance) {
    return {
      matches: false,
      lateAdjusted: false
    };
  }

  /*
   * CASE 3:
   * Use Canvas's original score before the
   * automatic late deduction.
   *
   * This is the preferred verification method.
   */
  const rawEntered = submission.entered_score;

  const enteredScore =
    rawEntered === null || rawEntered === undefined ? NaN : Number(rawEntered);

  if (Number.isFinite(enteredScore)) {
    const matches = close(enteredScore, expectedGrade);

    return {
      matches,
      lateAdjusted: matches
    };
  }

  /*
   * CASE 4:
   * Canvas did not return entered_score.
   *
   * Reconstruct the original grade from
   * the final score and the late deduction.
   */
  const rawDeduction = submission.points_deducted;

  const deducted =
    rawDeduction === null || rawDeduction === undefined
      ? NaN
      : Number(rawDeduction);

  if (
    Number.isFinite(deducted) &&
    deducted > 0 &&
    (close(score + deducted, expectedGrade) ||
      (close(score, 0) && deducted >= expectedGrade - tolerance))
  ) {
    return {
      matches: true,
      lateAdjusted: true
    };
  }

  /*
   * The difference cannot be explained
   * by Canvas's late penalty.
   */
  return {
    matches: false,
    lateAdjusted: false
  };
};

/**
 * Canvas grading integration.
 */
export class BulkGradeUpdater {
  constructor() {
    this.BASE_ENDPOINT = '';
    this.UPLOAD_ENDPOINT = '';
    this.KEY = '';

    this.ASSIGNMENT_ID = 0;
    this.COURSE_ID = 0;

    this.grade_data = {};
  }

  /**
   * Initialize the Canvas connection.
   */
  async setParameters(apiKey, courseId, assignmentId) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new Error('apiKey must be a nonempty string.');
    }

    for (const [label, id] of [
      ['courseId', courseId],
      ['assignmentId', assignmentId]
    ]) {
      if (typeof id !== 'string' && typeof id !== 'number') {
        throw new Error(`${label} must be a string or number.`);
      }
    }

    await canvasRequest('courses', apiKey);

    await canvasRequest(`courses/${courseId}`, apiKey);

    await canvasRequest(
      `courses/${courseId}/assignments/${assignmentId}`,
      apiKey
    );

    this.KEY = apiKey;
    this.COURSE_ID = courseId;
    this.ASSIGNMENT_ID = assignmentId;

    this.BASE_ENDPOINT = `courses/${courseId}/assignments/${assignmentId}/submissions`;

    this.UPLOAD_ENDPOINT = `${this.BASE_ENDPOINT}/update_grades`;

    return this;
  }

  /**
   * Add a student to the grading queue.
   */
  addStudent(studentId, grade, comment = undefined) {
    if (!this.BASE_ENDPOINT) {
      throw new Error('Call setParameters() first.');
    }

    if (typeof studentId !== 'string' && typeof studentId !== 'number') {
      throw new Error('studentId must be a string or number.');
    }

    if (typeof grade !== 'number' || !Number.isFinite(grade)) {
      throw new Error('grade must be a finite number.');
    }

    if (
      comment !== undefined &&
      comment !== null &&
      typeof comment !== 'string'
    ) {
      throw new Error('comment must be a string.');
    }

    this.grade_data[studentId] = {
      posted_grade: String(grade)
    };

    if (comment) {
      this.grade_data[studentId].text_comment = comment;
    }
  }

  /**
   * Update an existing queued student.
   */
  updateStudent(studentId, grade = undefined, comment = undefined) {
    if (!Object.hasOwn(this.grade_data, studentId)) {
      throw new Error('Student does not exist in queued data.');
    }

    if (grade !== undefined) {
      if (typeof grade !== 'number' || !Number.isFinite(grade)) {
        throw new Error('grade must be a finite number.');
      }

      this.grade_data[studentId].posted_grade = String(grade);
    }

    if (comment === '' || comment === null) {
      delete this.grade_data[studentId].text_comment;
    } else if (comment !== undefined) {
      if (typeof comment !== 'string') {
        throw new Error('comment must be a string.');
      }

      this.grade_data[studentId].text_comment = comment;
    }
  }

  /**
   * Upload grades and feedback individually.
   *
   * Regrades append new feedback comments.
   * Existing feedback is never deleted.
   *
   * Matching feedback is recognized by its
   * SHA-256-derived filename.
   *
   * Verified students are archived through
   * the callback provided by cs-546-grader.
   *
   * Failed students remain in submissions.
   */
  async sendUpdate(commentsAsFiles = false, onStudentVerified = undefined) {
    if (!this.BASE_ENDPOINT) {
      throw new Error('Call setParameters() first.');
    }

    if (
      onStudentVerified !== undefined &&
      typeof onStudentVerified !== 'function'
    ) {
      throw new TypeError('onStudentVerified must be a function if provided.');
    }

    const studentIds = Object.keys(this.grade_data);

    const failures = [];

    let savedCount = 0;
    let skippedCount = 0;

    console.log(
      `Sending ${studentIds.length} student grade(s) individually to Canvas.`
    );

    /*
     * Process students sequentially.
     */
    for (const [index, studentId] of studentIds.entries()) {
      const data = {
        ...this.grade_data[studentId]
      };

      const expectedGrade = Number(data.posted_grade);

      const feedback = data.text_comment || '';

      const hasFile = Boolean(commentsAsFiles && feedback);

      /*
       * Create a unique filename based on
       * the feedback's contents.
       */
      const digest = hasFile
        ? createHash('sha256').update(feedback, 'utf8').digest('hex')
        : null;

      const filename = hasFile
        ? `${this.ASSIGNMENT_ID}-${studentId}-${digest.slice(0, 16)}.txt`
        : null;

      console.log(`[${index + 1}/${studentIds.length}] Student ${studentId}`);

      try {
        /*
         * STEP 1:
         * Retrieve the existing submission.
         */
        const before = await fetchSubmission(
          this.BASE_ENDPOINT,
          this.KEY,
          studentId
        );

        /*
         * IMPORTANT:
         * Verify the grade with awareness of
         * Canvas's automatic late penalties.
         */
        const previousGrade = verifyGrade(before, expectedGrade);

        const gradeAlreadySaved = previousGrade.matches;

        /*
         * Check for identical feedback files.
         */
        const exactFeedbackAlreadyAttached =
          hasFile &&
          attachmentsFor(before).some(
            (file) =>
              file.filename === filename || file.display_name === filename
          );

        const textAlreadySaved =
          !hasFile &&
          (!feedback ||
            (before.submission_comments ?? []).some(
              (comment) => comment.comment === feedback
            ));

        /*
         * STEP 2:
         * Skip students whose grade and feedback
         * are already correct.
         *
         * A legitimate Canvas late deduction
         * does not prevent skipping or archiving.
         */
        if (
          gradeAlreadySaved &&
          (hasFile ? exactFeedbackAlreadyAttached : textAlreadySaved)
        ) {
          console.log(
            '  SKIPPED: Current grade and matching feedback already exist.'
          );

          if (previousGrade.lateAdjusted) {
            console.log(
              `  INFO: Canvas applied its late penalty ` +
                `(raw ${expectedGrade}, final ${before.score}); ` +
                'no CA review needed.'
            );
          }

          if (onStudentVerified) {
            await onStudentVerified(studentId);
          }

          skippedCount++;

          continue;
        }

        /*
         * STEP 3:
         * Prepare the grade update.
         */
        const form = new URLSearchParams();

        form.append('submission[posted_grade]', data.posted_grade);

        form.append('prefer_points_over_scheme', 'true');

        let newFileId = null;

        /*
         * Upload NEW feedback only when identical
         * feedback is not already attached.
         */
        if (hasFile && !exactFeedbackAlreadyAttached) {
          if (attachmentsFor(before).length) {
            console.log(
              '  INFO: Existing feedback left unchanged; adding a new comment.'
            );
          }

          const uploaded = await uploadFeedbackFile(
            this.BASE_ENDPOINT,
            this.KEY,
            studentId,
            filename,
            feedback
          );

          newFileId = uploaded.id;

          form.append(
            'comment[text_comment]',
            'Grading Feedback — see attached file.'
          );

          form.append('comment[file_ids][]', String(newFileId));

          console.log(`  Uploaded new feedback file (file ID ${newFileId}).`);
        } else if (hasFile) {
          /*
           * Identical feedback already exists.
           * Update the grade without duplicating it.
           */
          console.log(
            '  INFO: Matching feedback already attached; updating grade only.'
          );
        } else if (feedback && !textAlreadySaved) {
          form.append('comment[text_comment]', feedback);

          console.log('  Adding a new text feedback comment.');
        }

        /*
         * STEP 4:
         * Send the grade and any new feedback
         * together in one individual request.
         */
        const response = await canvasRequest(
          `${this.BASE_ENDPOINT}/${studentId}`,
          this.KEY,
          {
            method: 'PUT',
            contentType: 'application/x-www-form-urlencoded',
            body: form
          }
        );

        await response.text();

        /*
         * STEP 5:
         * Retrieve the updated submission
         * and verify the saved result.
         */
        const saved = await fetchSubmission(
          this.BASE_ENDPOINT,
          this.KEY,
          studentId
        );

        /*
         * Verify the original grade while
         * accounting for automatic late penalties.
         */
        const savedGrade = verifyGrade(saved, expectedGrade);

        const gradeSaved = savedGrade.matches;

        /*
         * Verify feedback attachment.
         */
        const fileSaved =
          !hasFile ||
          attachmentsFor(saved).some((file) =>
            newFileId !== null
              ? Number(file.id) === newFileId
              : file.filename === filename || file.display_name === filename
          );

        /*
         * Verify text feedback when applicable.
         */
        const textSaved =
          hasFile ||
          !feedback ||
          (saved.submission_comments ?? []).some(
            (comment) => comment.comment === feedback
          );

        /*
         * Only genuine verification failures
         * require CA attention.
         */
        if (!gradeSaved || !fileSaved || !textSaved) {
          throw new Error(
            `Canvas verification failed ` +
              `(grade=${gradeSaved}, ` +
              `attachment=${fileSaved}, ` +
              `text=${textSaved}; ` +
              `raw grade=${expectedGrade}, ` +
              `Canvas final score=${saved.score}, ` +
              `Canvas entered_score=${saved.entered_score ?? 'unknown'}, ` +
              `points_deducted=${saved.points_deducted ?? 'unknown'}, ` +
              `late=${saved.late ?? 'unknown'}, ` +
              `late_policy_status=${saved.late_policy_status ?? 'unknown'}). ` +
              'ZIP left in submissions; check the Canvas submission.'
          );
        }

        /*
         * A legitimate late penalty is informational,
         * not a grading failure.
         */
        if (savedGrade.lateAdjusted) {
          console.log(
            `  INFO: Canvas applied its late penalty ` +
              `(raw ${expectedGrade}, final ${saved.score}); ` +
              'no CA review needed.'
          );
        }

        /*
         * STEP 6:
         * Archive the ZIP only after successful
         * verification.
         */
        if (onStudentVerified) {
          await onStudentVerified(studentId);
        }

        savedCount++;

        console.log(
          '  SUCCESS: Grade and expected feedback verified; ZIP archived if configured.'
        );
      } catch (error) {
        /*
         * Record genuine failures and continue
         * processing the rest of the class.
         */
        const reason = error instanceof Error ? error.message : String(error);

        failures.push({
          studentId,
          reason
        });

        console.error(`  WARNING student ${studentId}: ${reason}`);
      }
    }

    /*
     * Final grading summary.
     */
    console.log(
      `Canvas grading summary: ` +
        `${savedCount} saved, ` +
        `${skippedCount} already present, ` +
        `${failures.length} need attention; ` +
        `${studentIds.length} total.`
    );

    if (failures.length) {
      console.warn(
        'CA: Review the following student IDs. Their ZIPs remain in submissions:'
      );

      for (const {studentId, reason} of failures) {
        console.warn(`  ${studentId}: ${reason}`);
      }
    }

    /*
     * Individual failures do not crash the grader.
     *
     * Verified ZIPs have already been archived.
     * Failed ZIPs remain for another run.
     */
    return {
      completed: savedCount,
      skipped: skippedCount,
      failed: failures.length,
      failures
    };
  }
}
