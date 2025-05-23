import { assertionFailed } from "ente-base/assert";
import type { ElectronMLWorker } from "ente-base/types/ipc";
import type { EnteFile } from "ente-media/file";
import { Matrix } from "ml-matrix";
import { getSimilarityTransformation } from "similarity-transformation";
import type { ImageBitmapAndData } from "./blob";
import {
    grayscaleIntMatrixFromNormalized2List,
    warpAffineFloat32List,
} from "./image";
import { clamp } from "./math";

/**
 * The version of the face indexing pipeline implemented by the current client.
 */
export const faceIndexingVersion = 1;

/**
 * The faces in a file (and an embedding for each of them).
 *
 * This interface describes the format of face related data (aka "face index")
 * for a file. This is the common subset that is present in both the fields that
 * are persisted on remote ({@link RemoteFaceIndex}) and locally
 * ({@link LocalFaceIndex}).
 *
 * - Face detections and embeddings (collectively called as the face index) are
 *   generated by the current client when uploading a file, or when noticing a
 *   file which doesn't yet have a face index. They are then uploaded (E2EE) to
 *   remote, and the relevant bits also saved locally in the ML DB for
 *   subsequent lookup or clustering.
 *
 * - This face index is then fetched by subsequent clients to avoid them having
 *   to reindex (indexing faces is a costly operation, esp. for mobile clients).
 *
 * In both these scenarios (whether generated locally or fetched from remote),
 * we end up with an some data described by this {@link FaceIndex} interface. We
 * modify it slightly, adding envelopes, when saving them locally or uploading
 * them to remote - those variations are described by the {@link LocalFaceIndex}
 * and {@link RemoteFaceIndex} types respectively.
 */
export interface FaceIndex {
    /**
     * The width (in px) of the image (file).
     *
     * Having the image dimensions here is useful since the coordinates inside
     * the {@link Face}s are all normalized (0 to 1) to the width and height of
     * the image.
     */
    width: number;
    /**
     * The height (in px) of the image (file).
     */
    height: number;
    /**
     * The list of faces (and their embeddings) detected in the file.
     *
     * Each of the items is a {@link Face}, containing the result of a face
     * detection, and an embedding for that detected face.
     */
    faces: Face[];
}

export type RemoteFaceIndex = FaceIndex & {
    /**
     * An integral version number of the indexing algorithm / pipeline.
     *
     * [Note: Embedding versions]
     *
     * Embeddings have an associated version so it is possible for us to make
     * backward compatible updates to the indexing process on newer clients.
     *
     * Clients agree out of band what a particular version means, and guarantee
     * that an embedding with a particular version will be the same (to epsilon
     * cosine similarity) irrespective of the client that indexed the file.
     *
     * If we bump the version of same model (say when indexing on a newer
     * client), we will do it in a manner that older client will be able to
     * consume the response.  The schema should not change in non-additive
     * manners. For example, say if we improve blur detection, older client
     * should just consume embeddings with a newer version and not try to index
     * the file again locally.
     *
     * When fetching from remote, if we get an embedding with version that is
     * older than the version the client supports, then the client should ignore
     * it. This way, the file will get reindexed locally and an embedding with a
     * newer version will also get saved to remote.
     *
     * In the case where the changes are not backward compatible and can only be
     * consumed by clients by making code changes, then we will introduce a new
     * subtype (top level key) in the derived data.
     */
    version: number;
    /**
     * The UA for the client which generated this embedding.
     */
    client: string;
};

export type LocalFaceIndex = FaceIndex & {
    /**
     * The ID of the {@link EnteFile} whose index this is.
     *
     * This is used as the primary key when storing the index locally (An
     * {@link EnteFile} is guaranteed to have its fileID be unique in the
     * namespace of the user. Even if someone shares a file with the user the
     * user will get a file entry with a fileID unique to them).
     */
    fileID: number;
};

/**
 * A face detected in a file, and an embedding for this detected face.
 *
 * During face indexing, we first detect all the faces in a particular file.
 * Then for each such detected region, we compute an embedding of that part of
 * the file. Together, this detection region and the emedding travel together in
 * this {@link Face} interface.
 */
export interface Face {
    /**
     * A unique identifier for the face.
     *
     * This ID is guaranteed to be unique for all the faces detected in all the
     * files for the user. In particular, each file can have multiple faces but
     * they all will get their own unique {@link faceID}.
     *
     * This ID is also meant to be stable across reindexing. That is, if the
     * same algorithm and hyperparameters are used to reindex the file, then it
     * should result in the same face IDs. This allows us leeway in letting
     * unnecessary reindexing happen in rare cases without invalidating the
     * clusters that rely on the presence of the given face ID.
     *
     * Finally, this face ID is not completely opaque. It consists of underscore
     * separated components, the first of which is the ID of the
     * {@link EnteFile} to which this face belongs. Client code can rely on this
     * structure and can parse it if needed using {@link fileIDFromFaceID}.
     */
    faceID: string;
    /**
     * The face detection. Describes the region within the image that was
     * detected to be a face, and a set of landmarks (e.g. "eyes") of the
     * detection.
     *
     * All coordinates are relative to and normalized by the image's dimension,
     * i.e. they have been normalized to lie between 0 and 1, with 0 being the
     * left (or top) and 1 being the width (or height) of the image.
     */
    detection: {
        /**
         * The region within the image that contains the face.
         *
         * All coordinates and sizes are between 0 and 1, normalized by the
         * dimensions of the image.
         * */
        box: Box;
        /**
         * Face "landmarks", e.g. eyes.
         *
         * The exact landmarks and their order depends on the face detection
         * algorithm being used.
         *
         * The coordinatesare between 0 and 1, normalized by the dimensions of
         * the image.
         */
        landmarks: Point[];
    };
    /**
     * An correctness probability (0 to 1) that the face detection algorithm
     * gave to the detection. Higher values are better.
     */
    score: number;
    /**
     * The computed blur for the detected face.
     *
     * The exact semantics and range for these (floating point) values depend on
     * the face indexing algorithm / pipeline version being used.
     * */
    blur: number;
    /**
     * An embedding for the face.
     *
     * This is an opaque numeric (signed floating point) vector whose semantics
     * and length depend on the version of the face indexing algorithm /
     * pipeline that we are using. However, within a set of embeddings with the
     * same version, the property is that two such embedding vectors will be
     * "cosine similar" to each other if they are both faces of the same person.
     */
    embedding: number[];
}

/** The x and y coordinates of a point. */
export interface Point {
    x: number;
    y: number;
}

/** The dimensions of something, say an image. */
export interface Dimensions {
    width: number;
    height: number;
}

/** A rectangle given by its top left coordinates and dimensions. */
export interface Box {
    /** The x coordinate of the the top left (xMin). */
    x: number;
    /** The y coordinate of the top left (yMin). */
    y: number;
    /** The width of the box. */
    width: number;
    /** The height of the box. */
    height: number;
}

/**
 * Extract the fileID of the {@link EnteFile} to which the face belongs from its
 * faceID.
 */
export const fileIDFromFaceID = (faceID: string) => {
    const fileID = parseInt(faceID.split("_")[0] ?? "");
    if (isNaN(fileID)) {
        assertionFailed(`Ignoring attempt to parse invalid faceID ${faceID}`);
        return undefined;
    }
    return fileID;
};

/**
 * Index faces in the given file.
 *
 * This function is the entry point to the face indexing pipeline. The file goes
 * through various stages:
 *
 * 1. Detect faces using ONNX/YOLO
 * 2. Align the face rectangles, compute blur.
 * 3. Compute embeddings using ONNX/MFNT for the detected face (crop).
 *
 * Once all of it is done, it returns the face rectangles and embeddings so that
 * they can be saved locally (for offline use), and also uploaded to the user's
 * remote storage so that their other devices can download them instead of
 * needing to reindex.
 *
 * @param file The {@link EnteFile} to index.
 *
 * @param image The file's contents.
 *
 * @param electron The {@link ElectronMLWorker} instance that allows us to call
 * our Node.js layer to run the ONNX inference.
 */
export const indexFaces = async (
    file: EnteFile,
    { data: imageData }: ImageBitmapAndData,
    electron: ElectronMLWorker,
): Promise<FaceIndex> => ({
    width: imageData.width,
    height: imageData.height,
    faces: await indexFaces_(file.id, imageData, electron),
});

const indexFaces_ = async (
    fileID: number,
    imageData: ImageData,
    electron: ElectronMLWorker,
): Promise<Face[]> => {
    const { width, height } = imageData;
    const imageDimensions = { width, height };

    const yoloFaceDetections = await detectFaces(imageData, electron);
    const partialResult = yoloFaceDetections.map(
        ({ box, landmarks, score }) => {
            const faceID = makeFaceID(fileID, box, imageDimensions);
            const detection = { box, landmarks };
            return { faceID, detection, score };
        },
    );

    const allAlignments = partialResult.map(({ detection }) =>
        computeFaceAlignment(detection),
    );

    let embeddings: Float32Array[] = [];
    let blurs: number[] = [];

    // Process the faces in batches of 50 to:
    //
    // 1. Avoid memory pressure (as on ONNX 1.80.0, we can reproduce a crash if
    //    we try to compute MFNet embeddings for a file with ~280 faces).
    //
    // 2. Reduce the time the main (Node.js) process is unresponsive (whenever
    //    the main thread of the Node.js process is CPU bound, the renderer also
    //    becomes unresponsive since events are routed via the main process).
    //
    const batchSize = 50;
    for (let i = 0; i < yoloFaceDetections.length; i += batchSize) {
        const alignments = allAlignments.slice(i, i + batchSize);
        const detections = partialResult
            .slice(i, i + batchSize)
            .map((f) => f.detection);

        const alignedFacesData = convertToMobileFaceNetInput(
            imageData,
            alignments,
        );

        embeddings = embeddings.concat(
            await computeEmbeddings(alignedFacesData, electron),
        );
        blurs = blurs.concat(detectBlur(alignedFacesData, detections));
    }

    return partialResult.map(({ faceID, detection, score }, i) => ({
        faceID,
        detection: normalizeByImageDimensions(detection, imageDimensions),
        score,
        blur: blurs[i]!,
        embedding: Array.from(embeddings[i]!),
    }));
};

/**
 * Detect faces in the given image.
 *
 * The model used is YOLOv5Face, running in an ONNX runtime.
 */
const detectFaces = async (
    imageData: ImageData,
    electron: ElectronMLWorker,
): Promise<YOLOFaceDetection[]> => {
    // The image pre-preprocessing happens within the model itself, using ONNX
    // primitives. This is more performant and also saves us from having to
    // reinvent (say) the antialiasing wheels.
    const {
        height: imageHeight,
        width: imageWidth,
        data: pixelData,
    } = imageData;
    const inputShape = [imageHeight, imageWidth, 4]; // [H, W, C]

    const scaledSize = getScaledSize(imageWidth, imageHeight);
    const yoloOutput = await electron.detectFaces(pixelData, inputShape);
    const faces = filterExtractDetectionsFromYOLOOutput(yoloOutput);
    const faceDetections = transformYOLOFaceDetections(
        faces,
        {
            x: (640 - scaledSize.width) / 2,
            y: (640 - scaledSize.height) / 2,
            width: scaledSize.width,
            height: scaledSize.height,
        },
        { x: 0, y: 0, width: imageWidth, height: imageHeight },
    );

    return faceDetections;
};

/**
 * Calculate image scaling done inside ONNX model run preprocessing. Needed to
 * correct the output.
 */
const getScaledSize = (imageWidth: number, imageHeight: number) => {
    const requiredWidth = 640;
    const requiredHeight = 640;

    const scale = Math.min(
        requiredWidth / imageWidth,
        requiredHeight / imageHeight,
    );
    const scaledWidth = clamp(Math.round(imageWidth * scale), 0, requiredWidth);
    const scaledHeight = clamp(
        Math.round(imageHeight * scale),
        0,
        requiredHeight,
    );
    return { width: scaledWidth, height: scaledHeight };
};

interface YOLOFaceDetection {
    box: Box;
    landmarks: Point[];
    score: number;
}

/**
 * Extract detected faces from the YOLOv5Face's output.
 *
 * Only detections that exceed a minimum score are returned.
 *
 * @param rows A Float32Array of shape [25200, 16], where each row represents a
 * face detection.
 *
 * YOLO detects a fixed number of faces, 25200, always from the input it is
 * given. Each detection is a "row" of 16 bytes, containing the bounding box,
 * score, and landmarks of the detection.
 *
 * We prune out detections with a score lower than our threshold. However, we
 * will still be left with some overlapping detections of the same face: these
 * we will deduplicate in {@link removeDuplicateDetections}.
 */
const filterExtractDetectionsFromYOLOOutput = (
    rows: Float32Array,
): YOLOFaceDetection[] => {
    const faces: YOLOFaceDetection[] = [];
    // Iterate over each row.
    for (let i = 0; i < rows.length; i += 16) {
        const score = rows[i + 4]!;
        if (score < 0.7) continue;

        const xCenter = rows[i]!;
        const yCenter = rows[i + 1]!;
        const width = rows[i + 2]!;
        const height = rows[i + 3]!;
        const x = xCenter - width / 2.0; // topLeft
        const y = yCenter - height / 2.0; // topLeft

        const leftEyeX = rows[i + 5]!;
        const leftEyeY = rows[i + 6]!;
        const rightEyeX = rows[i + 7]!;
        const rightEyeY = rows[i + 8]!;
        const noseX = rows[i + 9]!;
        const noseY = rows[i + 10]!;
        const leftMouthX = rows[i + 11]!;
        const leftMouthY = rows[i + 12]!;
        const rightMouthX = rows[i + 13]!;
        const rightMouthY = rows[i + 14]!;

        const box = { x, y, width, height };
        const landmarks = [
            { x: leftEyeX, y: leftEyeY },
            { x: rightEyeX, y: rightEyeY },
            { x: noseX, y: noseY },
            { x: leftMouthX, y: leftMouthY },
            { x: rightMouthX, y: rightMouthY },
        ];
        faces.push({ box, landmarks, score });
    }
    return faces;
};

/**
 * Transform the given {@link yoloFaceDetections} from their coordinate system in
 * which they were detected ({@link inBox}) back to the coordinate system of the
 * original image ({@link toBox}).
 */
const transformYOLOFaceDetections = (
    yoloFaceDetections: YOLOFaceDetection[],
    inBox: Box,
    toBox: Box,
): YOLOFaceDetection[] => {
    const scaleX = toBox.width / inBox.width;
    const scaleY = toBox.height / inBox.height;
    const translateX = toBox.x - inBox.x;
    const translateY = toBox.y - inBox.y;

    const correctDetections: YOLOFaceDetection[] = [];

    for (const detection of yoloFaceDetections) {
        const score = detection.score;

        const box = detection.box;
        box.x = (box.x + translateX) * scaleX;
        box.y = (box.y + translateY) * scaleY;
        box.width *= scaleX;
        box.height *= scaleY;

        const landmarks = detection.landmarks;
        landmarks.forEach((p) => {
            p.x = (p.x + translateX) * scaleX;
            p.y = (p.y + translateY) * scaleY;
        });
        correctDetections.push({ score, box, landmarks });
    }

    return correctDetections;
};

const makeFaceID = (fileID: number, box: Box, image: Dimensions) => {
    const part = (v: number) => clamp(v, 0.0, 0.999999).toFixed(5).substring(2);
    const xMin = part(box.x / image.width);
    const yMin = part(box.y / image.height);
    const xMax = part((box.x + box.width) / image.width);
    const yMax = part((box.y + box.height) / image.height);
    return [`${fileID}`, xMin, yMin, xMax, yMax].join("_");
};

interface FaceAlignment {
    /**
     * An affine transformation matrix (rotation, translation, scaling) to align
     * the face extracted from the image.
     */
    affineMatrix: number[][];
    /**
     * The bounding box of the transformed box.
     *
     * The affine transformation shifts the original detection box a new,
     * transformed, box (possibly rotated). This property is the bounding box
     * of that transformed box. It is in the coordinate system of the original,
     * full, image on which the detection occurred.
     */
    boundingBox: Box;
}

/**
 * Compute and return an {@link FaceAlignment} for the given face detection.
 *
 * @param faceDetection A geometry indicating a face detected in an image.
 */
const computeFaceAlignment = (faceDetection: FaceDetection): FaceAlignment =>
    computeFaceAlignmentUsingSimilarityTransform(
        faceDetection,
        normalizeLandmarks(idealMobileFaceNetLandmarks, mobileFaceNetFaceSize),
    );

/**
 * The ideal location of the landmarks (eye etc) that the MobileFaceNet
 * embedding model expects.
 */
const idealMobileFaceNetLandmarks: [number, number][] = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];

const normalizeLandmarks = (
    landmarks: [number, number][],
    faceSize: number,
): [number, number][] =>
    landmarks.map(([x, y]) => [x / faceSize, y / faceSize]);

const computeFaceAlignmentUsingSimilarityTransform = (
    faceDetection: FaceDetection,
    alignedLandmarks: [number, number][],
): FaceAlignment => {
    const landmarksMat = new Matrix(
        faceDetection.landmarks
            .map((p) => [p.x, p.y])
            .slice(0, alignedLandmarks.length),
    ).transpose();
    const alignedLandmarksMat = new Matrix(alignedLandmarks).transpose();

    const simTransform = getSimilarityTransformation(
        landmarksMat,
        alignedLandmarksMat,
    );

    const RS = Matrix.mul(simTransform.rotation, simTransform.scale);
    const TR = simTransform.translation;

    const affineMatrix = [
        [RS.get(0, 0), RS.get(0, 1), TR.get(0, 0)],
        [RS.get(1, 0), RS.get(1, 1), TR.get(1, 0)],
        [0, 0, 1],
    ];

    const size = 1 / simTransform.scale;
    const meanTranslation = simTransform.toMean.sub(0.5).mul(size);
    const centerMat = simTransform.fromMean.sub(meanTranslation);
    const center = { x: centerMat.get(0, 0), y: centerMat.get(1, 0) };

    const boundingBox = {
        x: center.x - size / 2,
        y: center.y - size / 2,
        width: size,
        height: size,
    };

    return { affineMatrix, boundingBox };
};

const convertToMobileFaceNetInput = (
    imageData: ImageData,
    faceAlignments: FaceAlignment[],
): Float32Array => {
    const faceSize = mobileFaceNetFaceSize;
    const faceData = new Float32Array(
        faceAlignments.length * faceSize * faceSize * 3,
    );
    for (let i = 0; i < faceAlignments.length; i++) {
        const { affineMatrix } = faceAlignments[i]!;
        const faceDataOffset = i * faceSize * faceSize * 3;
        warpAffineFloat32List(
            imageData,
            affineMatrix,
            faceSize,
            faceData,
            faceDataOffset,
        );
    }
    return faceData;
};

interface FaceDetection {
    box: Box;
    landmarks: Point[];
}

/**
 * Laplacian blur detection.
 *
 * Return an array of detected blur values, one for each face detection in
 * {@link faceDetections}. The face data is taken from the slice of
 * {@link alignedFacesData} corresponding to the face of {@link faceDetections}.
 */
const detectBlur = (
    alignedFacesData: Float32Array,
    faceDetections: FaceDetection[],
): number[] =>
    faceDetections.map((d, i) => {
        const faceImage = grayscaleIntMatrixFromNormalized2List(
            alignedFacesData,
            i,
            mobileFaceNetFaceSize,
            mobileFaceNetFaceSize,
        );
        return matrixVariance(applyLaplacian(faceImage, faceDirection(d)));
    });

type FaceDirection = "left" | "right" | "straight";

export const faceDirection = ({ landmarks }: FaceDetection): FaceDirection => {
    const leftEye = landmarks[0]!;
    const rightEye = landmarks[1]!;
    const nose = landmarks[2]!;
    const leftMouth = landmarks[3]!;
    const rightMouth = landmarks[4]!;

    const eyeDistanceX = Math.abs(rightEye.x - leftEye.x);
    const eyeDistanceY = Math.abs(rightEye.y - leftEye.y);
    const mouthDistanceY = Math.abs(rightMouth.y - leftMouth.y);

    const faceIsUpright =
        Math.max(leftEye.y, rightEye.y) + 0.5 * eyeDistanceY < nose.y &&
        nose.y + 0.5 * mouthDistanceY < Math.min(leftMouth.y, rightMouth.y);

    const noseStickingOutLeft =
        nose.x < Math.min(leftEye.x, rightEye.x) &&
        nose.x < Math.min(leftMouth.x, rightMouth.x);

    const noseStickingOutRight =
        nose.x > Math.max(leftEye.x, rightEye.x) &&
        nose.x > Math.max(leftMouth.x, rightMouth.x);

    const noseCloseToLeftEye =
        Math.abs(nose.x - leftEye.x) < 0.2 * eyeDistanceX;
    const noseCloseToRightEye =
        Math.abs(nose.x - rightEye.x) < 0.2 * eyeDistanceX;

    if (noseStickingOutLeft || (faceIsUpright && noseCloseToLeftEye)) {
        return "left";
    } else if (noseStickingOutRight || (faceIsUpright && noseCloseToRightEye)) {
        return "right";
    }

    return "straight";
};

/**
 * Return a new image by applying a Laplacian blur kernel to each pixel.
 */
const applyLaplacian = (
    image: number[][],
    direction: FaceDirection,
): number[][] => {
    const paddedImage = padImage(image, direction);
    const numRows = paddedImage.length - 2;
    const numCols = paddedImage[0]!.length - 2;

    // Create an output image initialized to 0.
    const outputImage = Array.from(
        { length: numRows },
        () => new Array(numCols).fill(0) as number[],
    );

    // Define the Laplacian kernel.
    const kernel = [
        [0, 1, 0],
        [1, -4, 1],
        [0, 1, 0],
    ];

    // Apply the kernel to each pixel
    for (let i = 0; i < numRows; i++) {
        for (let j = 0; j < numCols; j++) {
            let sum = 0;
            for (let ki = 0; ki < 3; ki++) {
                for (let kj = 0; kj < 3; kj++) {
                    sum += paddedImage[i + ki]![j + kj]! * kernel[ki]![kj]!;
                }
            }
            // Adjust the output value if necessary (e.g., clipping).
            outputImage[i]![j] = sum;
        }
    }

    return outputImage;
};

const padImage = (image: number[][], direction: FaceDirection): number[][] => {
    const removeSideColumns = 56; /* must be even */

    const numRows = image.length;
    const numCols = image[0]!.length;
    const paddedNumCols = numCols + 2 - removeSideColumns;
    const paddedNumRows = numRows + 2;

    // Create a new matrix with extra padding.
    const paddedImage = Array.from(
        { length: paddedNumRows },
        () => new Array(paddedNumCols).fill(0) as number[],
    );

    if (direction == "straight") {
        // Copy original image into the center of the padded image.
        for (let i = 0; i < numRows; i++) {
            for (let j = 0; j < paddedNumCols - 2; j++) {
                paddedImage[i + 1]![j + 1] =
                    image[i]![j + Math.round(removeSideColumns / 2)]!;
            }
        }
    } else if (direction == "left") {
        // If the face is facing left, we only take the right side of the face
        // image.
        for (let i = 0; i < numRows; i++) {
            for (let j = 0; j < paddedNumCols - 2; j++) {
                paddedImage[i + 1]![j + 1] = image[i]![j + removeSideColumns]!;
            }
        }
    } else {
        // If the face is facing right, we only take the left side of the face
        // image.
        for (let i = 0; i < numRows; i++) {
            for (let j = 0; j < paddedNumCols - 2; j++) {
                paddedImage[i + 1]![j + 1] = image[i]![j]!;
            }
        }
    }

    // Reflect padding
    // - Top and bottom rows
    for (let j = 1; j <= paddedNumCols - 2; j++) {
        // Top row
        paddedImage[0]![j] = paddedImage[2]![j]!;
        // Bottom row
        paddedImage[numRows + 1]![j] = paddedImage[numRows - 1]![j]!;
    }
    // - Left and right columns
    for (let i = 0; i < numRows + 2; i++) {
        // Left column
        paddedImage[i]![0] = paddedImage[i]![2]!;
        // Right column
        paddedImage[i]![paddedNumCols - 1] =
            paddedImage[i]![paddedNumCols - 3]!;
    }

    return paddedImage;
};

const matrixVariance = (matrix: number[][]): number => {
    const numRows = matrix.length;
    const numCols = matrix[0]!.length;
    const totalElements = numRows * numCols;

    // Calculate the mean.
    let mean = 0;
    matrix.forEach((row) => {
        row.forEach((value) => {
            mean += value;
        });
    });
    mean /= totalElements;

    // Calculate the variance.
    let variance = 0;
    matrix.forEach((row) => {
        row.forEach((value) => {
            const diff: number = value - mean;
            variance += diff * diff;
        });
    });
    variance /= totalElements;

    return variance;
};

const mobileFaceNetFaceSize = 112;
const mobileFaceNetEmbeddingSize = 192;

/**
 * Compute embeddings for the given {@link faceData}.
 *
 * The model used is MobileFaceNet, running in an ONNX runtime.
 */
const computeEmbeddings = async (
    faceData: Float32Array,
    electron: ElectronMLWorker,
): Promise<Float32Array[]> => {
    const outputData = await electron.computeFaceEmbeddings(faceData);

    const embeddingSize = mobileFaceNetEmbeddingSize;
    const embeddings = new Array<Float32Array>(
        outputData.length / embeddingSize,
    );
    for (let i = 0; i < embeddings.length; i++) {
        embeddings[i] = new Float32Array(
            outputData.slice(i * embeddingSize, (i + 1) * embeddingSize),
        );
    }
    return embeddings;
};

/**
 * Convert the coordinates to between 0-1, normalized by the image's dimensions.
 */
const normalizeByImageDimensions = (
    faceDetection: FaceDetection,
    { width, height }: Dimensions,
): FaceDetection => {
    const oldBox: Box = faceDetection.box;
    const box = {
        x: oldBox.x / width,
        y: oldBox.y / height,
        width: oldBox.width / width,
        height: oldBox.height / height,
    };
    const landmarks = faceDetection.landmarks.map((l) => ({
        x: l.x / width,
        y: l.y / height,
    }));
    return { box, landmarks };
};
